"""Fixed H-only adapter for the existing owner-local website stage.

This adds no swap algorithm, worker launch, image selection authority or owner
HTTP endpoint. The initial installation and compiled lifecycle runtime supply
the protected program/image facts; the existing stage retains plan, lock,
checkpoint, CAS and forward-only receipts.
"""
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import uuid
import time
import http.client
import socket
import urllib.parse
import argparse
import importlib.util
import sys
from contextlib import nullcontext

from . import owner_terminal_lifecycle as L
from .owner_terminal_native import private_bytes, private_document
from .website_image_provenance import verify_image_spec
from .website_service_auth import WEB, protected_startup
from .linux_root_files import open_in_root
from .owner_terminal_bind_sources import canonical_mount_records

LINK_PURPOSE = 'owner-terminal-console-links-v1'
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')


def need(value, reason):
    if not value:
        raise ValueError(reason)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def _auth_stamp(info):
    return [*L._native_stamp(info), info.st_gid]


def auth_mount_facts(mounts, selected, uid):
    """Only metadata of the existing protected config; never read its contents."""
    guest = PurePosixPath(selected)
    covered = [m for m in mounts if guest == PurePosixPath(m['Destination'])
               or guest.is_relative_to(PurePosixPath(m['Destination']))]
    need(len(covered) == 1 and covered[0]['Type'] == 'bind' and covered[0]['RW'] is False
         and not any(PurePosixPath(m['Destination']).is_relative_to(guest)
                     and PurePosixPath(m['Destination']) != guest for m in mounts),
         'H_WEBSITE_SERVICE_AUTH_MOUNT')
    mount = covered[0]; source = Path(mount['Source'])
    need(source.is_absolute() and source.resolve(strict=True) == source,
         'H_WEBSITE_SERVICE_AUTH_SOURCE')
    relative = guest.relative_to(PurePosixPath(mount['Destination']))
    fd = os.open(source, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
    facts = []
    try:
        for part in (*relative.parts, None):
            info = os.fstat(fd); facts.append(_auth_stamp(info))
            need(info.st_uid in (0, uid) and not info.st_mode & 0o022,
                 'H_WEBSITE_SERVICE_AUTH_SOURCE')
            if part is None:break
            need(stat.S_ISDIR(info.st_mode), 'H_WEBSITE_SERVICE_AUTH_SOURCE')
            following = os.open(part, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd); fd = following
        # Match the ordinary config's root/service-UID, non-writable trust
        # boundary. Secret key permissions remain the server's existing rule.
        need(stat.S_ISREG(info.st_mode) and info.st_uid in (0, uid) and info.st_nlink == 1
             and not info.st_mode & 0o022, 'H_WEBSITE_SERVICE_AUTH_FILE')
    finally:os.close(fd)
    return {'mount': {k: mount.get(k) for k in ('Type', 'Source', 'Destination', 'RW', 'Propagation')},
            'identities': facts}


def _auth_process(pid):
    return L.read_proc(pid)


def _auth_root(pid):
    # Intentionally open this kernel magic link; all guest descendants use
    # openat2 IN_ROOT|NO_MAGICLINKS|NO_SYMLINKS, never host Path.resolve().
    return os.open('/proc/' + str(pid) + '/root', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)


def _auth_birth(pid):
    # After stop a reused PID may be unrelated: read only bounded kernel stat,
    # not that replacement process's argv, executable or namespaces.
    from .worker_resource_reservations import _pid
    return int(_pid(pid))


def _close_auth_fds(fds):
    failed = False
    while fds:
        try:os.close(fds.pop())
        except OSError:failed = True
    need(not failed, 'H_WEBSITE_AUTH_CLOSE_UNCONFIRMED')


def describe_link_facts(initial, standard, container_id):
    """Read only the fixed known console links; never follow a guest absolute link.

    These are reviewable filesystem facts, not an authorization or checkpoint.
    No account file, transcript, directory listing or process environment is
    read from the guest. The declared website data-directory setting comes from
    fixed engine metadata. The later adapter repeats the real metadata checks.
    """
    need(type(initial) is L.InitialInstallation, 'H_WEBSITE_FIXED_INSTALLATION_REQUIRED')
    need(type(container_id) is str and re.fullmatch('[a-f0-9]{64}', container_id), 'H_WEBSITE_EXACT_OLD_CID')
    config = initial.guard()
    old = standard.container_metadata(initial.engine.get('/containers/' + container_id + '/json'))
    need(old.get('Id') == container_id and old.get('Name') == '/' + config['serverContainer']
         and not (old['Config'].get('Labels') or {}).get('reverie.worker'), 'H_WEBSITE_CURRENT_CONTAINER_REQUIRED')
    env = standard.environment(old['Config'].get('Env') or [])
    get = lambda k, default: env.get(k, k + '=' + default).split('=', 1)[1] or default
    console = get('REVERIE_DATA_DIR', get('REVERIE_DATA', '/instances/default') + '/console')
    root = Path(standard.resolve_mounted(console, old)['hostPath'])
    raw, identity = L._data_bytes(config['companyFile'], 16 << 20)
    company = json.loads(raw); rows = company.get('employees')
    need(type(rows) is list and len(rows) <= 128 and all(type(row) is dict for row in rows), 'H_WEBSITE_COMPANY_REQUIRED')
    candidates = [('chatroom-files', '/reverie_workspace/attachments', None)]
    seen = set()
    for row in rows:
        sid = row.get('sessionId'); eid = row.get('id'); generation = row.get('sessionGeneration')
        need(type(eid) is str and UUID.fullmatch(eid) and type(sid) is str and UUID.fullmatch(sid)
             and type(generation) is int and generation >= 1 and sid not in seen, 'H_WEBSITE_CURRENT_BINDING_REQUIRED')
        seen.add(sid)
        candidates.append(('custom-model-configs/' + sid + '/projects', '/instances/default/accounts/claude/projects',
                           {'employeeId': eid, 'sessionId': sid, 'generation': generation,
                            'ownerDigest': hashlib.sha256(encoded({'owner': row.get('owner')})).hexdigest()}))
    result = []
    for relative, target, binding in candidates:
        path = root / relative
        try:
            parent = standard.open_path(path.parent)
        except FileNotFoundError:
            continue
        try:
            try:info = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:continue
            if not stat.S_ISLNK(info.st_mode):continue  # Remains included in the ordinary full backup.
            need(info.st_uid == os.getuid() and info.st_nlink == 1
                 and os.readlink(path.name, dir_fd=parent) == target
                 and not (binding is not None and next(row for row in rows if row['id'] == binding['employeeId']).get('bindingMigration')),
                 'H_WEBSITE_LINK_NOT_SUPPORTED')
            need(standard._stamp(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) == standard._stamp(info),
                 'H_WEBSITE_LINK_CHANGED')
        finally:
            os.close(parent)
        guest = PurePosixPath(target)
        mounts = [(len(PurePosixPath(m['Destination']).parts), m) for m in old['Mounts']
                  if guest == PurePosixPath(m['Destination']) or guest.is_relative_to(PurePosixPath(m['Destination']))]
        need(mounts, 'H_WEBSITE_LINK_TARGET_NOT_MOUNTED')
        _, mount = max(mounts, key=lambda pair: pair[0]);need(mount['Type'] == 'bind', 'H_WEBSITE_LINK_TARGET_NOT_MOUNTED')
        mapped = Path(mount['Source']).joinpath(*guest.relative_to(PurePosixPath(mount['Destination'])).parts)
        try:
            target_info = mapped.stat();need(stat.S_ISDIR(target_info.st_mode), 'H_WEBSITE_LINK_TARGET_TYPE')
            target_identity = target_info.st_dev, target_info.st_ino
        except FileNotFoundError:
            target_identity = None, None
        result.append({'path': relative, 'device': info.st_dev, 'inode': info.st_ino, 'target': target,
                       'targetDevice': target_identity[0], 'targetInode': target_identity[1], 'binding': binding})
    need(len(result) <= 32 and L._data_bytes(config['companyFile'], 16 << 20) == (raw, identity),
         'H_WEBSITE_LINK_BINDING_CHANGED')
    current = standard.container_metadata(initial.engine.get('/containers/' + container_id + '/json'))
    need(all(current.get(k) == old.get(k) for k in ('Id', 'Image', 'Name', 'Config', 'HostConfig', 'Mounts')),
         'H_WEBSITE_CURRENT_CONTAINER_CHANGED')
    need(L._native_stamp(Path(config['companyFile']).lstat()) == identity, 'H_WEBSITE_LINK_BINDING_CHANGED')
    for fact in result:
        info = (root / fact['path']).lstat()
        need(stat.S_ISLNK(info.st_mode) and (info.st_dev, info.st_ino) == (fact['device'], fact['inode']),
             'H_WEBSITE_LINK_CHANGED')
    return {'version': 1, 'purpose': LINK_PURPOSE, 'links': sorted(result, key=lambda row: row['path'])}


class TerminalWebsiteProfile:
    """One closed protected profile, never a caller-selected hook or command."""
    def __init__(self, initial, link_facts, *, old_id=None):
        need(type(initial) is L.InitialInstallation, 'H_WEBSITE_FIXED_INSTALLATION_REQUIRED')
        need(initial.runtime.value['profile'] == 'terminal', 'H_WEBSITE_H_ONLY_REQUIRED')
        self.initial = initial
        self.links_path = Path(link_facts)
        # controlBase has an exact initial-only directory contract; keep this
        # independent reviewed fact file in the equally private ledger base.
        need(self.links_path.parent == initial.roots['ledgerBase'], 'H_WEBSITE_LINK_CONTROL_LOCATION')
        self.links, self.links_identity = private_document(self.links_path)
        need(type(self.links) is dict and set(self.links) == {'version', 'purpose', 'links'}
             and type(self.links['version']) is int and self.links['version'] == 1
             and self.links['purpose'] == LINK_PURPOSE and type(self.links['links']) is list
             and len(self.links['links']) <= 32, 'H_WEBSITE_LINK_SCHEMA')
        paths = []
        for link in self.links['links']:
            need(type(link) is dict and set(link) == {'path', 'device', 'inode', 'target',
                 'targetDevice', 'targetInode', 'binding'}, 'H_WEBSITE_LINK_SCHEMA')
            path = link['path']; paths.append(path)
            need(type(path) is str and str(PurePosixPath(path)) == path
                 and not any(x in ('', '.', '..') for x in path.split('/')),
                 'H_WEBSITE_LINK_PATH')
            need(all(type(link[x]) is int and link[x] >= 0 for x in ('device', 'inode')),
                 'H_WEBSITE_LINK_IDENTITY')
            need((link['targetDevice'] is None and link['targetInode'] is None) or
                 all(type(link[x]) is int and link[x] >= 0 for x in ('targetDevice', 'targetInode')),
                 'H_WEBSITE_LINK_TARGET_IDENTITY')
            if path == 'chatroom-files':
                need(link['binding'] is None and link['target'] == '/reverie_workspace/attachments',
                     'H_WEBSITE_LINK_TARGET')
            else:
                parts = path.split('/'); binding = link['binding']
                need(len(parts) == 3 and parts[0] == 'custom-model-configs' and parts[2] == 'projects'
                     and UUID.fullmatch(parts[1]) and type(binding) is dict
                     and set(binding) == {'employeeId', 'sessionId', 'generation', 'ownerDigest'}
                     and type(binding['employeeId']) is str and UUID.fullmatch(binding['employeeId'])
                     and binding['sessionId'] == parts[1] and type(binding['generation']) is int
                     and binding['generation'] >= 1 and type(binding['ownerDigest']) is str
                     and re.fullmatch('[a-f0-9]{64}', binding['ownerDigest'])
                     and link['target'] == '/instances/default/accounts/claude/projects',
                     'H_WEBSITE_LINK_BINDING')
        need(len(set(paths)) == len(paths), 'H_WEBSITE_DUPLICATE_LINK')
        from .resource_actor_install import artifact
        self.provenance = artifact(initial.runtime.value['imageProvenance'])
        self.auth_fds = []; self.auth_held = []; self.auth_old = None; self.auth_candidate = None
        self.auth_closed = False
        need(old_id is None or type(old_id) is str and re.fullmatch('[a-f0-9]{64}',old_id),
             'H_WEBSITE_ALIAS_OLD_ID')
        self.alias_old_id=old_id;self.alias_facts=None;self.alias_held=[]
        command = self.provenance['imageSpec']['Config'].get('Cmd', [])
        self.auth = None
        if any(type(arg) is str and arg.startswith('--service-auth-config') for arg in command):
            self.auth = protected_startup(initial.program)
            need(self.auth['serviceAuthConfig'] is not None and self.auth['command'] == command,
                 'H_WEBSITE_SERVICE_AUTH_PROGRAM')
            try:self.auth_binding = self._auth_binding(acquire=True)
            except BaseException:
                self.close()
                raise
        self.operation = None
        try:self._alias_binding(acquire=True)
        except BaseException:
            self.close();raise

    def close(self):
        self.auth_closed = True;failed = False
        try:_close_auth_fds(self.auth_fds)
        except Exception:failed = True
        self.auth_held = []
        for item in self.alias_held:
            try:item.close()
            except Exception:failed = True
        self.alias_held=[]
        need(not failed,'H_WEBSITE_DESCRIPTOR_CLOSE_UNCONFIRMED')

    def _alias_binding(self, *, acquire=False):
        need(not self.auth_closed,'H_WEBSITE_AUTH_PROOF_CLOSED')
        if self.alias_old_id is None:return []
        from .owner_terminal_bind_sources import bound_mounts,inspected_row
        for held in self.alias_held:held.check_source()
        old=self.initial.engine.get('/containers/'+self.alias_old_id+'/json')
        need(old['Id']==self.alias_old_id,'H_WEBSITE_ALIAS_OLD_ID')
        with bound_mounts(self.initial.engine,[inspected_row(old)]) as bindings:
            facts=[{'destination':item.mount['Destination'],'source':copy.deepcopy(item.facts)}
                   for item in bindings if item.facts is not None]
            facts.sort(key=lambda item:item['destination'])
            if acquire:
                need(all(item.process is not None for item in bindings if item.facts is not None),
                     'H_WEBSITE_ALIAS_LIVE_OLD_REQUIRED')
                self.alias_facts=facts
                for item in bindings:
                    if item.facts is not None:self.alias_held.append(item.retain())
            else:need(facts==self.alias_facts,'H_WEBSITE_BIND_SOURCE_CHANGED')
        cid=getattr(self,'created_id',None)
        if cid is not None:
            candidate=self.initial.engine.get('/containers/'+cid+'/json')
            need(candidate['Id']==cid,'H_WEBSITE_CREATED_CID_CHANGED')
            with bound_mounts(self.initial.engine,[inspected_row(candidate)]) as bindings:
                actual=[]
                for item in bindings:
                    if item.mount['Destination']=='/run/reverie-owner-terminal':
                        need(item.path==self.initial.roots['bootstrapRoot'] and item.mount['Source']==str(item.path)
                             and not item.facts['aliased'] and item.mount['RW'] is False,
                             'H_WEBSITE_BOOTSTRAP_SOURCE_CHANGED')
                    else:actual.append({'destination':item.mount['Destination'],'source':copy.deepcopy(item.facts)})
                actual.sort(key=lambda item:item['destination'])
                need(actual==self.alias_facts,'H_WEBSITE_BIND_SOURCE_CHANGED')
        for held in self.alias_held:held.check_source()
        return copy.deepcopy(self.alias_facts)

    def _auth_guest(self, item, binding, expected=None, *, retain=False):
        state = item['State']; pid = state.get('Pid')
        need(state.get('Running') is True and not any(state.get(k) for k in ('Paused', 'Restarting', 'Dead'))
             and type(pid) is int and pid > 1, 'H_WEBSITE_AUTH_INIT_REQUIRED')
        before = _auth_process(pid); fds = []
        try:
            root = _auth_root(pid); fds.append(root); root_info = os.fstat(root)
            mounted = open_in_root(root, binding['mount']['Destination'], path_link=True); fds.append(mounted)
            leaf = open_in_root(root, self.auth['serviceAuthConfig'], path_link=True); fds.append(leaf)
            identities = [_auth_stamp(os.fstat(fd)) for fd in (mounted, leaf)]
            need(identities == [binding['identities'][0], binding['identities'][-1]],
                 'H_WEBSITE_AUTH_GUEST_SOURCE_CHANGED')
            proof = {'process': before, 'root': [root_info.st_dev, root_info.st_ino],
                     'mount': identities[0], 'leaf': identities[1]}
            named = _auth_root(pid)
            try:
                current_root = os.fstat(named)
                need([current_root.st_dev, current_root.st_ino] == proof['root'],
                     'H_WEBSITE_AUTH_INIT_CHANGED')
            finally:_close_auth_fds([named])
            need(_auth_process(pid) == before and
                 [os.fstat(root).st_dev, os.fstat(root).st_ino] == proof['root'],
                 'H_WEBSITE_AUTH_INIT_CHANGED')
            need(expected is None or proof == expected, 'H_WEBSITE_AUTH_INIT_CHANGED')
            if retain:
                self.auth_held.extend([(root, proof['root'], True),
                                       (mounted, identities[0], False), (leaf, identities[1], False)])
                self.auth_fds.extend(fds); fds = []
            return proof
        finally:_close_auth_fds(fds)

    def _auth_binding(self, *, acquire=False):
        need(not self.auth_closed, 'H_WEBSITE_AUTH_PROOF_CLOSED')
        path = self.initial.roots['ledgerBase'] / 'website-selection.json'
        selection, identity = private_document(path)
        cid = selection.get('oldId')
        need(type(cid) is str and re.fullmatch('[a-f0-9]{64}', cid), 'H_WEBSITE_SERVICE_AUTH_SELECTION')
        old = self.initial.engine.get('/containers/' + cid + '/json')
        need(old.get('Id') == cid, 'H_WEBSITE_SERVICE_AUTH_SELECTION')
        binding = auth_mount_facts(old['Mounts'], self.auth['serviceAuthConfig'], os.getuid())
        if acquire:
            self.auth_old = self._auth_guest(old, binding, retain=True)
        elif old['State'].get('Running') is True:
            self._auth_guest(old, binding, self.auth_old)
        else:
            need(old['State'].get('Running') is False and old['State'].get('Pid') == 0
                 and not any(old['State'].get(k) for k in ('Paused', 'Restarting', 'Dead')),
                 'H_WEBSITE_AUTH_OLD_STATE_UNKNOWN')
            try:actual = _auth_birth(self.auth_old['process']['pid'])
            except (FileNotFoundError, ProcessLookupError):actual = None
            need(actual is None or actual != self.auth_old['process']['start'],
                 'H_WEBSITE_AUTH_OLD_INIT_STILL_LIVE')
        if self.auth_candidate is not None:
            candidate = self.initial.engine.get('/containers/' + self.created_id + '/json')
            need(candidate.get('Id') == self.created_id, 'H_WEBSITE_CREATED_CID_CHANGED')
            self._auth_guest(candidate, binding, self.auth_candidate)
        # Hold the original namespace/root and bound inodes through OLD stop.
        # Reopening the host source alone cannot establish OLD's mounted file.
        for fd, expected, root in self.auth_held:
            info = os.fstat(fd)
            actual = [info.st_dev, info.st_ino] if root else _auth_stamp(info)
            need(actual == expected, 'H_WEBSITE_AUTH_HELD_CHANGED')
        again = self.initial.engine.get('/containers/' + cid + '/json')
        need(all(again.get(k) == old.get(k) for k in ('Id', 'Image'))
             and canonical_mount_records(again['Mounts'])==canonical_mount_records(old['Mounts'])
             and all(again['State'].get(k) == old['State'].get(k)
                     for k in ('Pid', 'Running', 'Paused', 'Restarting', 'Dead', 'StartedAt')),
             'H_WEBSITE_AUTH_INIT_CHANGED')
        need(auth_mount_facts(again['Mounts'], self.auth['serviceAuthConfig'], os.getuid()) == binding,
             'H_WEBSITE_SERVICE_AUTH_CHANGED')
        return {'selectionIdentity': list(identity), 'selectionSHA256': hashlib.sha256(encoded(selection)).hexdigest(),
                'binding': binding, 'oldGuestAtCapture': self.auth_old}

    def input_binding(self):
        value, identity = private_document(self.links_path)
        need(value == self.links and identity == self.links_identity, 'H_WEBSITE_LINK_FACTS_CHANGED')
        initial_raw, initial_identity = private_bytes(self.initial.path)
        need(initial_identity == self.initial.identity and json.loads(initial_raw) == self.initial.value,
             'H_WEBSITE_INSTALLATION_CHANGED')
        result = {'installationSHA256': hashlib.sha256(initial_raw).hexdigest(),
                'installationIdentity': list(initial_identity),
                'rootIdentities': {name: list(identity) for name, identity in self.initial.root_ids.items()},
                'runtimeManifest': self.initial.runtime.pair,
                'linkFactsSHA256': hashlib.sha256(encoded(self.links)).hexdigest(),
                'linkFactsIdentity': list(self.links_identity),
                'bindSourceAliases': self._alias_binding()}
        if self.auth is not None:
            need(self._auth_binding() == self.auth_binding, 'H_WEBSITE_SERVICE_AUTH_CHANGED')
            result['serviceAuth'] = copy.deepcopy(self.auth_binding)
        return result

    def require_launch(self, old, target):
        normal = ['/bin/tini', '-g', '-s', '--', '/usr/local/bin/reverie-start']
        expected = self.provenance['imageSpec']['Config']
        need(target.get('Cmd') == expected.get('Cmd')
             and target.get('Entrypoint') == expected.get('Entrypoint'), 'H_WEBSITE_FIXED_TARGET_PROGRAM')
        # Unknown legacy wrappers remain unsupported. No substring/basename
        # exception converts a guest executable into a qualified startup.
        cmd = old.get('Cmd')
        plain = (old.get('Entrypoint') == normal and type(cmd) is list and len(cmd) >= 2
                 and cmd[0] in ('reverie', '/bin/reverie') and cmd[1] == 'web')
        fixed = old.get('Cmd') == expected.get('Cmd') and old.get('Entrypoint') == expected.get('Entrypoint')
        need(plain or fixed, 'H_WEBSITE_OLD_PROGRAM_UNSUPPORTED')

    def spec(self, original, old, previous, target, deployment):
        aliases=any(m.get('Type')=='bind' and Path(m['Source']).resolve(strict=True)!=Path(m['Source'])
                    for m in old['Mounts'])
        need(not aliases or self.alias_old_id==old['Id'],'H_WEBSITE_ALIAS_BASELINE_REQUIRED')
        verify_image_spec(self.provenance, target)
        need(deployment.get('websiteRuntime') == 'terminal' and deployment.get('protectedWebsite') is True
             and deployment.get('ownerTerminalConfig') == str(self.initial.path), 'H_WEBSITE_OWNER_SELECTION')
        command = old['Config'].get('Cmd'); previous_command = previous['Config'].get('Cmd')
        matched = command == previous_command
        if self.auth is not None:
            expected = [[entry, *WEB, '--service-auth-config', self.auth['serviceAuthConfig']]
                        for entry in ('reverie', '/bin/reverie')]
            matched = command in expected and previous_command in (
                command, [command[0], *WEB])
        need(matched and old['Config'].get('Entrypoint') == previous['Config'].get('Entrypoint'),
             'H_WEBSITE_EXPLICIT_OLD_COMMAND_UNSUPPORTED')
        host = old['HostConfig']
        need(not host.get('Privileged') and not host.get('CapAdd') and not host.get('Devices')
             and host.get('PidMode', '') == '' and host.get('IpcMode', 'private') == 'private'
             and host.get('SecurityOpt') in (None, [], ['no-new-privileges'], ['no-new-privileges:true'])
             and host.get('Tmpfs') in (None, {}), 'H_WEBSITE_SOURCE_AUTHORITY_UNSUPPORTED')
        config = self.initial.guard()
        need(old['Config']['User'] == str(config['uid']) + ':' + str(config['gid']), 'H_WEBSITE_OWNER_UID')
        result = original(old, previous, target, deployment['adminPhoneWake'], deployment.get('ownerCodingEvidence', True))
        if self.auth is not None:
            # Only the exact reviewed ordinary-auth -> compiled H-auth form.
            result['Cmd'] = copy.deepcopy(self.auth['command'])
            candidate_mounts = [{'Type': m['Type'], 'Source': m['Source'], 'Destination': m['Target'],
                                 'RW': not m.get('ReadOnly', False),
                                 'Propagation': m.get('BindOptions', {}).get('Propagation', 'rprivate')}
                                for m in result['HostConfig']['Mounts']]
            need(auth_mount_facts(old['Mounts'], self.auth['serviceAuthConfig'], os.getuid()) ==
                 auth_mount_facts(candidate_mounts, self.auth['serviceAuthConfig'], os.getuid()) ==
                 self.auth_binding['binding'], 'H_WEBSITE_SERVICE_AUTH_CHANGED')
        self.require_launch(old['Config'], result)
        need(result.get('Cmd') == target['Config'].get('Cmd'), 'H_WEBSITE_FIXED_TARGET_PROGRAM')
        result.pop('Hostname', None)  # Docker derives exactly the new CID prefix.
        h = result['HostConfig']
        h.update(ReadonlyRootfs=True, CapAdd=None, CapDrop=['ALL'], SecurityOpt=['no-new-privileges'],
                 PidMode='', IpcMode='private', Init=True,
                 Tmpfs={'/tmp': 'rw,nosuid,nodev,size=256m,mode=1777',
                        '/run': 'rw,nosuid,nodev,noexec,size=16m,mode=0755,uid=' + str(config['uid']) + ',gid=' + str(config['gid'])})
        bootstrap = str(self.initial.roots['bootstrapRoot'])
        need(not any(m['Target'] == '/run/reverie-owner-terminal' for m in h['Mounts']),
             'H_WEBSITE_EXISTING_BOOTSTRAP_REQUIRES_REVIEW')
        h['Mounts'].append({'Type': 'bind', 'Source': bootstrap, 'Target': '/run/reverie-owner-terminal',
                            'ReadOnly': True, 'BindOptions': {'CreateMountpoint': False}})
        from .website_peer_facts import protected_backend
        protected_backend({'Config': result, 'HostConfig': h,
                           'Mounts': [{'Type': m['Type'], 'Source': m['Source'], 'Destination': m['Target'],
                                       'RW': not m.get('ReadOnly', False), 'Propagation': m.get('BindOptions', {}).get('Propagation', 'rprivate')}
                                      for m in h['Mounts']]})
        return result

    def exclusions(self):
        self.input_binding()
        return ['accounts', *sorted(link['path'] for link in self.links['links'])]

    def assert_links(self, standard, old, spec):
        self.input_binding()
        if self.auth is not None:
            need(auth_mount_facts(old['Mounts'], self.auth['serviceAuthConfig'], os.getuid()) ==
                 self.auth_binding['binding'], 'H_WEBSITE_SERVICE_AUTH_CHANGED')
        env = standard.environment(spec.get('Env') or [])
        get = lambda k, default: env.get(k, k + '=' + default).split('=', 1)[1] or default
        console = get('REVERIE_DATA_DIR', get('REVERIE_DATA', '/instances/default') + '/console')
        mapped = standard.resolve_mounted(console, old); root = Path(mapped['hostPath'])
        config = self.initial.guard()
        company_raw, company_identity = L._data_bytes(config['companyFile'], 16 << 20)
        company = json.loads(company_raw)
        link_stamps = {}; target_facts = {}
        ancestry = {path: L._directory_identity(path) for path in
                    {parent for link in self.links['links'] for parent in (root / link['path']).parents}}
        need(len(ancestry) <= 4096, 'H_WEBSITE_LINK_ANCESTRY_BOUND')
        for link in self.links['links']:
            path = root / link['path']; parent = standard.open_path(path.parent)
            try:
                before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                need(stat.S_ISLNK(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1
                     and (before.st_dev, before.st_ino) == (link['device'], link['inode']), 'H_WEBSITE_LINK_CHANGED')
                need(os.readlink(path.name, dir_fd=parent) == link['target'], 'H_WEBSITE_LINK_CHANGED')
                link_stamps[path] = standard._stamp(before)
                need(standard._stamp(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) == standard._stamp(before),
                     'H_WEBSITE_LINK_CHANGED')
            finally:
                os.close(parent)
            binding = link['binding']
            if binding is not None:
                rows = [row for row in company['employees'] if row.get('id') == binding['employeeId']]
                need(len(rows) == 1 and rows[0].get('sessionId') == binding['sessionId']
                     and rows[0].get('sessionGeneration') == binding['generation']
                     and not rows[0].get('bindingMigration')
                     and hashlib.sha256(encoded({'owner': rows[0].get('owner')})).hexdigest() == binding['ownerDigest'],
                     'H_WEBSITE_LINK_BINDING_CHANGED')
            target = PurePosixPath(link['target']); candidates = []
            for mount in old['Mounts']:
                destination = PurePosixPath(mount['Destination'])
                if target == destination or target.is_relative_to(destination):
                    candidates.append((len(destination.parts), mount, destination))
            need(candidates, 'H_WEBSITE_LINK_TARGET_NOT_MOUNTED')
            _, mount, destination = max(candidates, key=lambda row: row[0])
            need(mount['Type'] == 'bind', 'H_WEBSITE_LINK_TARGET_NOT_MOUNTED')
            target_path = Path(mount['Source']).joinpath(*target.relative_to(destination).parts)
            try:
                info = target_path.stat(); need(stat.S_ISDIR(info.st_mode), 'H_WEBSITE_LINK_TARGET_TYPE')
                actual = info.st_dev, info.st_ino
            except FileNotFoundError:
                actual = None, None
            need(actual == (link['targetDevice'], link['targetInode']), 'H_WEBSITE_LINK_TARGET_CHANGED')
            target_facts[target_path] = actual
            again = path.lstat()
            need(standard._stamp(again) == standard._stamp(before), 'H_WEBSITE_LINK_CHANGED')
        self.input_binding()
        need(L._data_bytes(config['companyFile'], 16 << 20) == (company_raw, company_identity),
             'H_WEBSITE_LINK_BINDING_CHANGED')
        # Every content reader and descriptor finalizer is now complete. Recheck
        # target/ancestry metadata first, then the original named leaves last.
        for path, expected in target_facts.items():
            try:
                info = path.stat(); need(stat.S_ISDIR(info.st_mode), 'H_WEBSITE_LINK_TARGET_TYPE')
                actual = info.st_dev, info.st_ino
            except FileNotFoundError:
                actual = None, None
            need(actual == expected, 'H_WEBSITE_LINK_TARGET_CHANGED')
        need(all(L._directory_identity(path) == identity for path, identity in ancestry.items()),
             'H_WEBSITE_LINK_ANCESTRY_CHANGED')
        need(all(L._directory_identity(path) == self.initial.root_ids[name]
                 for name, path in self.initial.roots.items()), 'H_WEBSITE_INSTALLATION_ROOT_CHANGED')
        need(all(standard._stamp(path.lstat()) == identity for path, identity in link_stamps.items()),
             'H_WEBSITE_LINK_CHANGED')
        need(L._native_stamp(Path(config['companyFile']).lstat()) == company_identity,
             'H_WEBSITE_LINK_BINDING_CHANGED')
        need(L._native_stamp(self.links_path.lstat()) == self.links_identity
             and L._native_stamp(self.initial.path.lstat()) == self.initial.identity,
             'H_WEBSITE_LINK_FACTS_CHANGED')

    def begin(self, stage, operation, plan):
        need(self.operation is None, 'H_WEBSITE_ATTEMPT_ALREADY_USED')
        self.operation, self.plan = Path(operation), copy.deepcopy(plan)
        self.stage = stage

    def phase(self, name, method, *args):
        need(self.operation is not None, 'H_WEBSITE_ATTEMPT_REQUIRED')
        self.stage._save(self.operation / ('H-' + name + '-ATTEMPT.json'), {'state': 'ATTEMPT_NO_REPLAY'}, exclusive=True)
        result = method(self.stage._lock_fd, *args)
        self.stage._save(self.operation / ('H-' + name + '-RESULT.json'), result, exclusive=True)
        return result

    def settle(self):
        return self.phase('settle', self.initial.settle)

    def verify_mounts(self, candidate, old_mounts):
        bootstrap = ('bind', str(self.initial.roots['bootstrapRoot']), '/run/reverie-owner-terminal', False, 'rprivate')
        actual = [tuple(m.get(k) for k in ('Type', 'Source', 'Destination', 'RW', 'Propagation'))
                  for m in candidate['Mounts'] if m.get('Type') != 'tmpfs']
        need(sorted(actual, key=repr) == sorted([*old_mounts, bootstrap], key=repr), 'H_WEBSITE_MOUNT_GRANTS_CHANGED')
        temporary = [m for m in candidate['Mounts'] if m.get('Type') == 'tmpfs']
        need(len(temporary) == 2 and {m['Destination'] for m in temporary} == {'/tmp', '/run'}
             and all(m.get('RW') is True for m in temporary), 'H_WEBSITE_TMPFS_CHANGED')

    def validate_created(self, candidate, plan, old_mounts):
        self.verify_mounts(candidate, old_mounts)
        # The shared qualifier validates ALL generated intent against actual
        # create readback before that readback becomes the H policy's spec.
        name = candidate['Name'][1:]
        spec = plan['spec']; host = spec['HostConfig']
        ports = host['PortBindings']
        need(set(ports) == {'3000/tcp'} and len(ports['3000/tcp']) == 1
             and ports['3000/tcp'][0]['HostIp'] == '127.0.0.1', 'H_WEBSITE_PORT_GRANTS')
        intent = {'name': name, 'user': spec['User'], 'workdir': spec['WorkingDir'],
                  'memory': host['Memory'], 'swap': host['MemorySwap'], 'pids': host['PidsLimit'],
                  'port': int(ports['3000/tcp'][0]['HostPort']), 'tmpfs': host['Tmpfs'],
                  'hostFloors': {k: host[k] for k in ('MaskedPaths', 'ReadonlyPaths')},
                  'labels': spec['Labels'], 'environment': spec['Env'],
                  'mounts': [{'type': m['Type'], 'source': m['Source'], 'destination': m['Target'],
                              'readonly': m.get('ReadOnly', False)} for m in host['Mounts']]}
        image = self.initial.engine.get('/images/' + plan['newImage'] + '/json')
        verify_image_spec(self.provenance, image)
        folder = self.operation / ('H-qualifier-' + uuid.uuid4().hex); folder.mkdir(mode=0o700)
        for leaf, value in [('created.json', candidate), ('image.json', image), ('intent.json', intent)]:
            self.stage._save(folder / leaf, value, exclusive=True)
        program = Path(__file__).resolve().parents[2] / 'scripts/owner-terminal-lifecycle.mjs'
        node = self.initial.program['nodeInvocation']
        result = subprocess.run([node, str(program), 'validate-created', str(folder / 'created.json'),
                                 str(folder / 'image.json'), str(folder / 'intent.json'), str(folder / 'accepted.json')],
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=30, check=False,
                                env={'PATH': os.defpath, 'LANG': 'C', 'LC_ALL': 'C'})
        need(result.returncode == 0 and len(result.stdout) <= 128 and len(result.stderr) <= 65536,
             'H_WEBSITE_CREATED_QUALIFICATION_REFUSED')
        raw, _ = private_bytes(folder / 'accepted.json')
        need(result.stdout.decode().strip() == hashlib.sha256(raw).hexdigest(), 'H_WEBSITE_ACCEPTED_SPEC_CHANGED')
        self.accepted = folder / 'accepted.json'
        self.accepted_sha = hashlib.sha256(raw).hexdigest()
        self.created_id = candidate['Id']

    def before_start(self, candidate_id):
        need(candidate_id == self.created_id, 'H_WEBSITE_CREATED_CID_CHANGED')
        self.phase('preflight-created', self.initial.preflight_created, candidate_id, self.accepted, self.accepted_sha)
        self.phase('prepare-created', self.initial.prepare_created, candidate_id, self.accepted, self.accepted_sha)
        self.phase('start-listener', self.initial.start_listener)

    def await_ready(self, candidate_id):
        need(candidate_id == self.created_id, 'H_WEBSITE_CREATED_CID_CHANGED')
        result = self.phase('await-ready', self.initial.await_ready)
        if self.auth is not None:
            current = self.initial.engine.get('/containers/' + candidate_id + '/json')
            need(current.get('Id') == candidate_id, 'H_WEBSITE_CREATED_CID_CHANGED')
            self.auth_candidate = self._auth_guest(current, self.auth_binding['binding'], retain=True)
        self.input_binding()
        return result


class _NativeControl:
    """Actual owner-local metadata/custody port, distinct from OPS registration.

    The watched process roster is owner-supplied nonauthorizing metadata. Native
    observations qualify every supplied incarnation, not roster completeness.
    This port has no worker command, intent, account, resource or image writer.
    """
    def __init__(self, initial, selection, state, policy, standard):
        from .worker import load_config
        need(type(initial) is L.InitialInstallation, 'H_WEBSITE_FIXED_INSTALLATION_REQUIRED')
        self.initial, self.standard = initial, standard
        self.selection, self.selection_identity = private_document(selection)
        self.selection_path = Path(selection)
        value = self.selection
        need(type(value) is dict and set(value) == {'version', 'purpose', 'oldId', 'oldImage', 'newImage',
             'providerPIDs', 'expiresAtEpoch'} and type(value['version']) is int and value['version'] == 1
             and value['purpose'] == 'owner-terminal-website-selection-v1', 'H_WEBSITE_SELECTION')
        need(type(value['oldId']) is str and re.fullmatch('[a-f0-9]{64}', value['oldId'])
             and all(type(value[k]) is str and re.fullmatch('sha256:[a-f0-9]{64}', value[k]) for k in ('oldImage', 'newImage'))
             and value['oldImage'] != value['newImage'], 'H_WEBSITE_EXACT_IMAGE_IDS')
        pids = value['providerPIDs']
        need(type(pids) is list and len(pids) <= 256 and all(type(pid) is int and pid > 1 for pid in pids)
             and len(set(pids)) == len(pids), 'H_WEBSITE_WATCHED_PID_ROSTER')
        need(type(value['expiresAtEpoch']) in (int, float) and time.time() < value['expiresAtEpoch'] <= time.time() + 1800,
             'H_WEBSITE_WINDOW_REQUIRED')
        self.deadline = time.monotonic() + min(900, value['expiresAtEpoch'] - time.time())
        self.state, self.policy = Path(state), Path(policy)
        self.config = load_config(initial.value['workerConfig'])
        need(self.config.get('resourceActorConfig') is None, 'H_WEBSITE_ACTOR_REQUIRES_COMBINED_MAINTENANCE')
        self.name = self.config['serverContainer']; self.new_id = None; self.plan = None
        self.binding = {'resourceId': 'h-website-' + hashlib.sha256(encoded([initial.value['engine']['id'],
                         str(initial.path), str(state)])).hexdigest()[:32],
                        'containerName': self.name, 'stateDirectory': str(state),
                        'deploymentPath': str(initial.deployment_path), 'policyPath': str(policy),
                        'maintenanceLockDirectory': str(initial.lock_path.parent),
                        'generation': standard.digest({'installation': hashlib.sha256(private_bytes(initial.path)[0]).hexdigest(),
                                       'runtime': initial.runtime.pair})}

    def _time(self):
        need(time.monotonic() < self.deadline and time.time() < self.selection['expiresAtEpoch'], 'H_WEBSITE_WINDOW_EXPIRED')

    def _native(self):
        from .worker_resource_reservations import NativeObserver
        native = NativeObserver(L._CapacityProbe(self.config, self.initial.engine, self.deadline, None))
        native._local.deadline = self.deadline
        return native

    @staticmethod
    def _process(pid):
        from .owner_terminal_channel import read_proc
        before = read_proc(pid); root = (Path('/proc') / str(pid) / 'root').stat()
        need(read_proc(pid) == before, 'H_WEBSITE_PROCESS_CHANGED')
        return {**before, 'root': [root.st_dev, root.st_ino]}

    def snapshot(self):
        from .resource_actor_refresh import RegisteredTransport
        from .worker_service import WorkerService
        from .worker_resume_peer import host_peer
        from .worker_storage import storage_paths
        from . import worker_resource_reservations as R
        from .owner_terminal_resource_binding import _profiles
        from .worker_host_job import require_idle
        from .owner_terminal_toolkit import immutable_manifest, qualify
        self._time(); config = self.initial.guard()
        need(config == self.config, 'H_WEBSITE_WORKER_CONFIG_CHANGED')
        worker_selection = self.initial.worker_selection
        company, company_identity = L._data_bytes(config['companyFile'], 16 << 20)
        selection, identity = private_document(self.selection_path)
        need(selection == self.selection and identity == self.selection_identity, 'H_WEBSITE_SELECTION_CHANGED')
        proof = RegisteredTransport(WorkerService(Path(self.initial.value['workerConfig'])), config)
        try:
            host_peer(proof.credentials, config['uid'])
            peer_process = self._process(proof.selection['pid'])
            need(all(peer_process[k] == v for k, v in proof.selection['process'].items()), 'H_WEBSITE_BROKER_CHANGED')
            peer = {'process': peer_process, 'socket': proof.selection['socket'],
                    'unit': proof.selection['unit'], 'target': str(proof.target),
                    'generationRoot': proof.selection['generationRoot']}
            gate = R.ReservationGate(L._CapacityProbe(config, self.initial.engine, self.deadline, None)) if R.configured(config) else None
            resource = None
            with gate.admission(deadline=self.deadline) if gate is not None else nullcontext():
                if gate is not None:
                    require_idle(gate);document = gate._document();profiles = _profiles(gate)
                    need(not gate.active_operations(document), 'H_WEBSITE_RESOURCE_WORK_ACTIVE')
                    resource = {'binding': copy.deepcopy(gate.binding), 'operations': document, 'profiles': profiles}
                native = self._native(); rows = native.inventory(self.deadline)
                workers = [r for r in rows if (r['Config'].get('Labels') or {}).get('reverie.worker') == config['deployment']]
                manifest = immutable_manifest(self.initial.runtime.value['toolkitManifest']['path'])
                employees = json.loads(company).get('employees')
                need(type(employees) is list, 'H_WEBSITE_COMPANY_REQUIRED')
                for eid in self.initial.value['entitlements']:
                    selected = [e for e in employees if e.get('id') == eid]
                    need(len(selected) == 1 and not selected[0].get('bindingMigration'), 'H_WEBSITE_ENTITLEMENT_BINDING_CHANGED')
                    employee = selected[0]
                    if employee.get('desiredRunning') is not True or employee.get('onVacation') is True:continue
                    matches = [r for r in workers if r['Config']['Labels'].get('reverie.employee') == eid
                               and r['Config']['Labels'].get('reverie.session') == employee.get('sessionId')]
                    need(len(matches) == 1 and matches[0]['State']['Running'] is True, 'H_WEBSITE_ENTITLED_LAPTOP_UNAVAILABLE')
                    # Read only the fixed public static ELF files/passwd mapping.
                    # Never install H over a known live laptop lacking its kit.
                    qualify(matches[0], manifest, uid=config['uid'], gid=config['gid'])
                roots = []
                for row in workers:
                    if row['State']['Running']:
                        sid = row['Config']['Labels'].get('reverie.session')
                        native.limits(row); native.storage(row, storage_paths(config, sid))
                        roots.append(self._process(row['State']['Pid']))
                watched = [self._process(pid) for pid in self.selection['providerPIDs']]
                need(all(any(p['root'] == r['root'] and p['namespaces'] == r['namespaces'] for r in roots) for p in watched),
                     'H_WEBSITE_WATCHED_PROCESS_OUTSIDE_LAPTOPS')
                if gate is not None:
                    require_idle(gate)
                    need(gate._document() == document and _profiles(gate) == profiles, 'H_WEBSITE_RESOURCE_STORES_CHANGED')
            proof.finalize(); proof = None
            need(private_bytes(self.initial.value['workerConfig']) == worker_selection, 'H_WEBSITE_CURRENT_BINDING_CHANGED')
            # All channel/admission finalizers precede the final native bracket.
            need(native.inventory(self.deadline) == rows
                 and [self._process(p['pid']) for p in watched] == watched
                 and [self._process(p['pid']) for p in roots] == roots, 'H_WEBSITE_NATIVE_CHANGED')
            need(self._process(peer['process']['pid']) == peer['process'], 'H_WEBSITE_BROKER_CHANGED')
            need(L._native_stamp(Path(config['companyFile']).lstat()) == company_identity
                 and L._native_stamp(Path(self.initial.value['workerConfig']).lstat()) == worker_selection[1],
                 'H_WEBSITE_CURRENT_BINDING_CHANGED')
            need(L._native_stamp(self.selection_path.lstat()) == self.selection_identity, 'H_WEBSITE_SELECTION_CHANGED')
            self._time()
            excluded = {self.selection['oldId'], self.new_id}
            retained = [row for row in rows if row['Id'] not in excluded]
            sources = sorted({m['Source'] for row in retained for m in row['Mounts'] if m.get('Type') == 'bind'})
            return {'workerBindSources': sources, 'websiteControlBinding': self.binding,
                    'workerConfigDigest': hashlib.sha256(worker_selection[0]).hexdigest(),
                    'workerConfigIdentity': worker_selection[1],
                    'companyDigest': hashlib.sha256(company).hexdigest(),
                    'companyIdentity': company_identity,
                    'nativeContainersDigest': self.standard.digest(retained),
                    'watchedProcessFacts': watched, 'broker': peer,
                    'resourceStoresDigest': self.standard.digest(resource),
                    'selectionDigest': self.standard.digest(self.selection), 'selectionIdentity': self.selection_identity}
        finally:
            if proof is not None:proof.close()

    def admit_control_custody(self, binding, paths, sources):
        from .owner_control import custody_digests
        self._time();need(binding == self.binding, 'H_WEBSITE_CONTROL_BINDING_CHANGED')
        native = self._native()
        rows = None
        for path in paths:
            rows = native.custody(Path(path), self.initial.path, deadline=self.deadline)
        self.initial.guard();self._time()
        return {**custody_digests(binding, paths, sources), 'evidenceDigest': self.standard.digest(rows)}

    def bind_plan(self, plan):
        need(self.plan is None and type(plan) is dict and set(plan) == self.standard.PLAN_KEYS
             and plan['oldId'] == self.selection['oldId']
             and plan['oldImage'] == self.selection['oldImage'] and plan['newImage'] == self.selection['newImage'],
             'H_WEBSITE_PLAN_SELECTION_CHANGED')
        self.plan = copy.deepcopy(plan)

    def http_ready(self, container_id, _spec):
        need(container_id == self.new_id, 'H_WEBSITE_CREATED_CID_CHANGED')
        bindings = self.plan['spec']['HostConfig']['PortBindings']['3000/tcp']
        need(len(bindings) == 1 and bindings[0]['HostIp'] == '127.0.0.1', 'H_WEBSITE_PORT_GRANTS')
        port = int(bindings[0]['HostPort']);end = min(self.deadline, time.monotonic() + 60)
        while time.monotonic() < end:
            self._time();client = http.client.HTTPConnection('127.0.0.1', port, timeout=min(2, end - time.monotonic()))
            try:
                client.request('GET', '/api/status');response = client.getresponse()
                body = response.read(4097)
                if response.status == 401 and len(body) <= 4096:
                    current = self.initial.engine.get('/containers/' + container_id + '/json')
                    need(current['State']['Running'] is True and current['Name'] == '/' + self.name,
                         'H_WEBSITE_READY_INCARNATION_CHANGED')
                    return True
            except (OSError, http.client.HTTPException):
                pass
            finally:
                client.close()
            time.sleep(min(.2, max(0, end - time.monotonic())))
        raise ValueError('H_WEBSITE_HTTP_READINESS_UNAVAILABLE')

    def __call__(self, method, path, data=None):
        self._time()
        if method == 'GET':
            if re.fullmatch(r'/images/sha256:[a-f0-9]{64}/json', path):return self.initial.engine.get(path)
            match = re.fullmatch(r'/containers/([^/]+)/json', path)
            need(match is not None and data is None, 'H_WEBSITE_METADATA_ROUTE')
            selector = urllib.parse.unquote(match[1])
            if re.fullmatch('[a-f0-9]{64}', selector):return self.standard.container_metadata(self.initial.engine.get('/containers/' + selector + '/json'))
            allowed = {self.name}
            if self.plan is not None:allowed.update({self.name + '-candidate-' + self.plan['operationId'], self.name + '-before-' + self.plan['operationId']})
            need(selector in allowed, 'H_WEBSITE_METADATA_SELECTOR')
            rows = self.initial.engine.get('/containers/json?all=1')
            found = [row for row in rows if '/' + selector in row.get('Names', [])]
            need(len(found) == 1, 'H_WEBSITE_CONTAINER_NAME_AMBIGUOUS')
            return self.standard.container_metadata(self.initial.engine.get('/containers/' + found[0]['Id'] + '/json'))
        need(method == 'POST' and self.plan is not None, 'H_WEBSITE_EFFECT_WITHOUT_PLAN')
        p = self.plan
        allowed = {'/containers/create?name=' + self.name + '-candidate-' + p['operationId']: p['spec'],
                   '/containers/' + p['oldId'] + '/stop?t=30': None,
                   '/containers/' + p['oldId'] + '/rename?name=' + self.name + '-before-' + p['operationId']: None}
        if self.new_id:
            allowed.update({'/containers/' + self.new_id + '/rename?name=' + self.name: None,
                            '/containers/' + self.new_id + '/start': None,
                            '/containers/' + self.new_id + '/stop?t=5': None})
        need(path in allowed and data == allowed[path], 'H_WEBSITE_EFFECT_ROUTE_OR_SPEC')
        if path == '/containers/' + p['oldId'] + '/stop?t=30':
            old = self.standard.container_metadata(self.initial.engine.get('/containers/' + p['oldId'] + '/json'))
            need(self.standard.digest(self.standard.container_pin(old)) == p['oldPin'], 'H_WEBSITE_OLD_CAS_CHANGED')
            expected = copy.deepcopy(old['HostConfig']);expected['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
            self._post('/containers/' + p['oldId'] + '/update', {'RestartPolicy': expected['RestartPolicy']})
            after = self.standard.container_metadata(self.initial.engine.get('/containers/' + p['oldId'] + '/json'))
            need(after['HostConfig'] == expected and after['Config'] == old['Config'] and after['Mounts'] == old['Mounts']
                 and after['State'] == old['State'], 'H_WEBSITE_OLD_RETENTION_UNCONFIRMED')
        result = self._post(path, data)
        if path.startswith('/containers/create?'):
            need(type(result) is dict and type(result.get('Id')) is str and re.fullmatch('[a-f0-9]{64}', result['Id'])
                 and result['Id'] != p['oldId'], 'H_WEBSITE_CREATED_ID_UNCONFIRMED')
            self.new_id = result['Id']
        return result

    def _post(self, path, value):
        from .website_peer_facts import _MetadataSocket, _remaining
        class MutationSocket(_MetadataSocket):
            def sendall(self, data, flags=0):
                view = memoryview(data)
                while view:
                    self.settimeout(_remaining(self.deadline))
                    count = socket.socket.send(self, view[:65536], flags)
                    need(count > 0, 'H_WEBSITE_EFFECT_UNCONFIRMED')
                    view = view[count:]
        self._time();self.initial.engine.guard()
        client = http.client.HTTPConnection('localhost', timeout=min(15, self.deadline - time.monotonic()))
        try:
            client.sock = MutationSocket(min(self.deadline, time.monotonic() + 15))
            client.sock.connect(self.initial.engine.path)
            self.initial.engine.guard();self._time()
            client.request('POST', path, body=None if value is None else encoded(value), headers={'Content-Type': 'application/json'})
            transport = client.sock
            response = client.getresponse();raw = bytearray()
            while len(raw) <= 8 << 20:
                if response.length == 0 or response.isclosed():break
                self._time();transport.settimeout(min(15, self.deadline - time.monotonic()))
                chunk = response.read1(min(65536, (8 << 20) + 1 - len(raw)))
                if not chunk:break
                raw.extend(chunk)
            need(200 <= response.status < 300 and len(raw) <= 8 << 20 and response.length in (None, 0),
                 'H_WEBSITE_EFFECT_UNCONFIRMED')
            return json.loads(raw) if raw.strip() else None
        finally:
            client.close()


def _standard_stage():
    path = Path(__file__).resolve().parents[2] / 'apps/host/website-update.py'
    loader = importlib.util.spec_from_file_location('_fixed_h_website_stage', path)
    module = importlib.util.module_from_spec(loader);loader.loader.exec_module(module)
    return module


def main(argv=None, *, runtime_manifest=None, service_binding=None):
    """Only a Nix-generated optional launcher supplies immutable program facts."""
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--installation', type=Path, required=True)
    parser.add_argument('action', choices=('describe-links', 'prepare', 'apply'))
    parser.add_argument('--operation')
    parser.add_argument('--plan-sha256')
    args = parser.parse_args(argv)
    if args.action == 'describe-links':
        if args.operation is not None or args.plan_sha256 is not None:parser.error('describe-links accepts no operation or plan')
    elif (type(args.operation) is not str or UUID.fullmatch(args.operation) is None
          or (args.action == 'apply') != (args.plan_sha256 is not None)):
        parser.error('Select one fresh UUID and only apply requires its exact plan SHA256')
    if args.plan_sha256 is not None and re.fullmatch('sha256:[a-f0-9]{64}', args.plan_sha256) is None:
        parser.error('Select the exact prepared plan SHA256')
    os.umask(0o077)
    profile = None
    try:
        need(runtime_manifest is not None and type(service_binding) is dict
             and set(service_binding) == {'unit', 'python', 'entry'}
             and all(type(value) is str for value in service_binding.values()), 'H_WEBSITE_PACKAGED_LAUNCHER_REQUIRED')
        from .website_image_provenance import immutable
        for name, limit in (('unit', 8192), ('python', 256 << 20), ('entry', 16 << 20)):
            path = Path(service_binding[name]);immutable(path.resolve(strict=True), limit)
            need(path.is_absolute() and path.is_relative_to('/nix/store'), 'H_WEBSITE_FIXED_SERVICE_BINDING')
        for key, field in (('REVERIE_WORKER_SERVICE_UNIT', 'unit'), ('REVERIE_WORKER_SERVICE_PYTHON', 'python'),
                           ('REVERIE_WORKER_SERVICE_ENTRY', 'entry')):
            os.environ[key] = service_binding[field]
        initial = L.InitialInstallation(args.installation, L.RuntimeManifest(runtime_manifest))
        need(initial.runtime.value['profile'] == 'terminal', 'H_WEBSITE_H_ONLY_REQUIRED')
        standard = _standard_stage();ledger = initial.roots['ledgerBase']
        selection = ledger / 'website-selection.json'
        value, _ = private_document(selection)
        need(type(value) is dict and type(value.get('oldId')) is str, 'H_WEBSITE_SELECTION')
        if args.action == 'describe-links':
            print(json.dumps(describe_link_facts(initial, standard._link_codec(), value['oldId']), sort_keys=True))
            return 0
        state = ledger / 'website-updates';policy = ledger / 'website-schema.json'
        native = _NativeControl(initial, selection, state, policy, standard)
        profile = TerminalWebsiteProfile(initial, ledger / 'website-links.json', old_id=native.selection['oldId'])
        stage = standard.WebsiteStage(native, state, initial.deployment_path, policy,
                                      guard=native, ready=native.http_ready, terminal=profile)
        # H/Python/Node/kernel await-ready always precedes the independent
        # bounded anonymous HTTP check and final full native snapshot.
        prepared = ledger / 'website-prepared'
        operation = prepared / args.operation
        if args.action == 'prepare':
            need(not os.path.lexists(operation), 'H_WEBSITE_PREPARE_ALREADY_USED')
            plan = stage.plan(native.name, value['newImage'], value['oldId'], value['oldImage'])
            # Admission precedes creation of any owned evidence directory.
            if not prepared.exists():prepared.mkdir(mode=0o700);L._sync(ledger)
            fd = L.open_directory(prepared)
            try:need(stat.S_IMODE(os.fstat(fd).st_mode) == 0o700 and os.fstat(fd).st_uid == os.getuid(), 'H_WEBSITE_PREPARED_CUSTODY')
            finally:os.close(fd)
            raw = encoded(plan);need(len(raw) <= 1 << 20, 'H_WEBSITE_PLAN_BOUND')
            operation.mkdir(mode=0o700);L._sync(prepared)
            L.exclusive(operation / 'PLAN.json', raw)
            native._time()
            profile.close(); profile = None
            print(json.dumps({'version': 1, 'state': 'H_WEBSITE_PREPARED', 'operation': args.operation,
                              'planDigest': standard.digest(plan), 'specDigest': plan['specPin'],
                              'finalSpecApproval': plan['finalSpecApproval'], 'effects': False}, sort_keys=True))
            return 0
        raw, _ = L._data_bytes(operation / 'PLAN.json', 1 << 20, private=True);plan = standard.strict(raw)
        need(standard.digest(plan) == args.plan_sha256, 'H_WEBSITE_PREPARED_PLAN_CHANGED')
        native.bind_plan(plan)
        record = stage.apply(plan, args.plan_sha256)
        profile.close(); profile = None
        print(json.dumps({'version': 1, 'state': 'H_WEBSITE_ADOPTED', 'receipt': record,
                          'providerCompletenessQualified': False, 'ownerShellAcceptanceRequired': True}, sort_keys=True))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        print('Laptop terminal website operation refused or unconfirmed. Retain its private state; it was not retried.', file=sys.stderr)
        return 1
    finally:
        if profile is not None:
            try:profile.close()
            except (OSError, ValueError, RuntimeError):
                print('Laptop terminal proof cleanup unconfirmed; retain its private state.', file=sys.stderr)
                return 1
