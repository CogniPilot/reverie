"""Native facts for a distinct host recovery stream, never human owner authority.

Plain websites are supported through root-owned code and unprivileged Node facts.
This does not claim H's read-only-root/capability boundary or alter ProtectedPeer.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import time
import math

from .owner_terminal_channel import need, read_proc, WebsitePeer, Program, digest
from .linux_root_files import open_in_root, mapped_root_uid
from .worker_resume_program import immutable, signature, require_programs, selected_programs, PURPOSE, MAX_FILES, MAX_BYTES


def host_peer(credentials, uid):
    pid, actual_uid, _gid = credentials
    need(actual_uid == uid == os.getuid() and pid > 1, 'RESUME_HOST_OWNER_REQUIRED')
    before = read_proc(pid); host = read_proc(os.getpid())
    need(before['namespaces'] == host['namespaces'], 'RESUME_HOST_NAMESPACE_REQUIRED')
    root = (Path('/proc') / str(pid) / 'root').stat(); own = Path('/').stat()
    need((root.st_dev, root.st_ino) == (own.st_dev, own.st_ino), 'RESUME_HOST_ROOT_REQUIRED')
    need(read_proc(pid) == before, 'RESUME_HOST_PEER_CHANGED')
    return before


def socket_mount(item, config):
    """The only native stream endpoint is the existing owner broker bind."""
    values=[value.split('=',1)[1] for value in item['Config']['Env']
            if value.startswith('REVERIE_WORKER_SOCKET=')]
    need(len(values)==1,'RESUME_SOCKET_ENV_REQUIRED')
    guest=Path(values[0]);host=Path(config['socket'])
    need(guest.is_absolute() and str(guest)==values[0] and '..'not in guest.parts and
         host.is_absolute() and host.resolve(strict=True)==host and guest.name==host.name,
         'RESUME_SOCKET_PATH')
    mounts=[mount for mount in item['Mounts'] if
            Path(mount['Destination'])==guest.parent or Path(mount['Destination'])in guest.parent.parents or
            guest.parent in Path(mount['Destination']).parents]
    need(len(mounts)==1 and mounts[0].get('Type')=='bind' and mounts[0].get('RW')is False and
         mounts[0]['Destination']==str(guest.parent) and mounts[0]['Source']==str(host.parent),
         'RESUME_SOCKET_READONLY_BIND_REQUIRED')
    info=host.lstat()
    need(stat.S_ISSOCK(info.st_mode) and info.st_uid==config['uid'] and
         stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1,'RESUME_SOCKET_CUSTODY')
    return guest,signature(info)


class ResumeWebsitePeer(WebsitePeer):
    """Only a broker-packaged complete graph can register the configured Node."""
    def __init__(self, broker, manifest_path, credentials):
        self.broker, self.credentials = broker, credentials
        self.manifest_path = immutable(manifest_path)
        before = signature(self.manifest_path.stat())
        with self.manifest_path.open('rb') as stream: raw = stream.read((16 << 20) + 1)
        need(len(raw) <= 16 << 20 and signature(self.manifest_path.stat()) == before,
             'RESUME_PROGRAM_MANIFEST_CHANGED')
        # This manifest is immutable package data, independently of wire frames.
        def pairs(items):
            value = {}
            for key, item in items:
                need(key not in value, 'RESUME_PROGRAM_MANIFEST_DUPLICATE'); value[key] = item
            return value
        value = json.loads(raw, object_pairs_hook=pairs)
        fields = {'version','purpose','console','nodeInvocation',
                  'nodeExecutable','programs','files','links','directories'}
        need(type(value) is dict and set(value) in (fields, fields | {'ownerTerminalProgram'})
             and type(value['version'])is int and value['version'] == 1 and
             value['purpose'] == PURPOSE, 'RESUME_PROGRAM_MANIFEST_SCHEMA')
        self.manifest, self.manifest_identity = value, before
        self.files = value['files']; console = Path(value['console'])
        need(console.is_relative_to('/nix/store') and console.resolve(strict=True) == console and
             type(self.files) is dict and 1 <= len(self.files) <= MAX_FILES and
             type(value['links']) is dict and type(value['directories']) is list and
             len(self.files) + len(value['links']) + len(value['directories']) <= MAX_FILES,
             'RESUME_PROGRAM_GRAPH_BOUND')
        require_programs(value)
        self.executable = immutable(value['nodeExecutable'])
        need(Path(value['nodeInvocation']).resolve(strict=True) == self.executable and
             str(self.executable) in self.files, 'RESUME_FIXED_NODE_REQUIRED')
        for path, fact in self.files.items():
            need(type(path) is str and (Path(path).is_relative_to(console) or path == str(self.executable)) and
                 type(fact) is dict and set(fact) == {'sha256','bytes','mode'} and type(fact['bytes']) is int and
                 0 <= fact['bytes'] <= 256 << 20 and type(fact['mode']) is int and not fact['mode'] & 0o222 and
                 type(fact['sha256']) is str and len(fact['sha256']) == 64 and
                 all(c in '0123456789abcdef' for c in fact['sha256']), 'RESUME_PROGRAM_GRAPH_SCHEMA')
        need(sum(fact['bytes'] for fact in self.files.values()) <= MAX_BYTES, 'RESUME_PROGRAM_GRAPH_BOUND')
        directory_set=set(value['directories'])
        need(len(directory_set)==len(value['directories']) and str(console) in directory_set and
             str(console/'lib/reverie/dist/index.js') in self.files and
             str(console/'lib/reverie/dist/host-worker-resume.js') in self.files,'RESUME_COMPLETE_PROGRAM_GRAPH')
        for path in [*self.files,*value['links'],*value['directories']]:
            if path==str(self.executable):continue
            selected=Path(path)
            need(selected.is_relative_to(console) and '..' not in selected.parts and str(selected)==path,
                 'RESUME_CANONICAL_PROGRAM_GRAPH')
            need(all(str(parent)in directory_set for parent in selected.parents if parent==console or parent.is_relative_to(console)),
                 'RESUME_COMPLETE_PROGRAM_GRAPH')
        self.children = {directory:set() for directory in value['directories']}
        for path in [*self.files, *value['links'], *value['directories']]:
            parent=str(Path(path).parent)
            if parent in self.children:self.children[parent].add(Path(path).name)
        self.config_image = broker.config['image']
        self.deadline = time.monotonic() + 60
        self.initial_item = self._item()
        self.initial = read_proc(self.initial_item['State']['Pid'])
        self.node_process = read_proc(credentials[0])
        self.code_identities = self.qualify_code()
        self.socket_identity = self.qualify_socket()
        self.assert_process(credentials, 'node')

    def _item(self):
        end = min(time.monotonic() + 5,self.deadline)
        need(time.monotonic()<end,'RESUME_PEER_DEADLINE')
        reply = self.broker.run_engine(['inspect', self.broker.config['serverContainer']], deadline=end)
        need(reply.returncode == 0 and len(reply.stdout) <= 2 << 20, 'RESUME_WEBSITE_NATIVE_UNAVAILABLE')
        rows = json.loads(reply.stdout)
        need(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict, 'RESUME_WEBSITE_NATIVE_UNAVAILABLE')
        item = rows[0]; state = item['State']; host = item['HostConfig']; config = item['Config']
        need(item['Name'] == '/' + self.broker.config['serverContainer'] and state['Running'] is True and
             not state.get('Paused') and not state.get('Restarting') and type(state['Pid']) is int and state['Pid'] > 1 and
             config['User'] == str(self.broker.config['uid']) + ':' + str(self.broker.config['gid']) and
             host['Privileged'] is False and host.get('PidMode') in ('','private'), 'RESUME_WEBSITE_NAMESPACE')
        env = config.get('Env', [])
        need(type(env) is list and all(type(x) is str for x in env) and not any(
             x.startswith('LD_') or x.split('=',1)[0] in {'NODE_OPTIONS','NODE_PATH','PYTHONPATH','PYTHONHOME'}
             for x in env), 'RESUME_WEBSITE_LOADER_ENV')
        for mount in item['Mounts']:
            target = Path(mount['Destination'])
            need(not any(target == Path(p) or target in Path(p).parents or Path(p) in target.parents
                         for p in (self.manifest['console'], str(self.executable))), 'RESUME_WEBSITE_CODE_MASKED')
        socket_mount(item,self.broker.config)
        return {'Id': item['Id'], 'Image': item['Image'], 'Name': item['Name'],
                'Config': config, 'HostConfig': host,
                'Mounts': sorted(item['Mounts'], key=lambda row: json.dumps(row,sort_keys=True)),
                'State': {k:state.get(k) for k in ('Running','Paused','Restarting','Pid','StartedAt')}}

    def qualify_socket(self):
        guest,host=socket_mount(self.initial_item,self.broker.config)
        root=os.open('/proc/'+str(self.initial['pid'])+'/root',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
        try:
            fd=open_in_root(root,str(guest),path_link=True)
            try:
                actual=os.fstat(fd)
                need(stat.S_ISSOCK(actual.st_mode) and signature(actual)==host,'RESUME_GUEST_SOCKET_CHANGED')
                return host
            finally:os.close(fd)
        finally:os.close(root)

    def inspect(self):
        need(self._item() == self.initial_item and read_proc(self.initial['pid']) == self.initial,
             'RESUME_WEBSITE_CHANGED')
        need(signature(self.manifest_path.stat()) == self.manifest_identity, 'RESUME_PROGRAM_MANIFEST_CHANGED')
        return self.initial_item

    def qualify_code(self):
        value = self.manifest; root = os.open('/proc/'+str(self.initial['pid'])+'/root', os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
        identities = {}; root_uid = mapped_root_uid(self.initial['pid'])
        try:
            for directory in value['directories']:
                need(Path(directory).is_relative_to(value['console']), 'RESUME_PROGRAM_DIRECTORY')
                fd = open_in_root(root, directory)
                try:
                    info = os.fstat(fd)
                    need(stat.S_ISDIR(info.st_mode) and info.st_uid == root_uid and not info.st_mode & 0o022,
                         'RESUME_GUEST_PROGRAM_DIRECTORY')
                    need(set(os.listdir(fd)) == self.children[directory], 'RESUME_PROGRAM_GRAPH_INVENTORY')
                    identities[directory] = signature(info)
                finally: os.close(fd)
            for path, fact in self.files.items():
                need(time.monotonic() < self.deadline, 'RESUME_PROGRAM_DEADLINE')
                host = immutable(path); fd = open_in_root(root, path)
                try:
                    info = os.fstat(fd)
                    need(stat.S_ISREG(info.st_mode) and info.st_uid == root_uid and
                         stat.S_IMODE(info.st_mode) == fact['mode'] and info.st_size == fact['bytes'],
                         'RESUME_GUEST_PROGRAM_FILE')
                    for stream in (host.open('rb'), os.fdopen(os.dup(fd),'rb')):
                        with stream:
                            hasher=hashlib.sha256();count=0
                            while data:=stream.read(1024**2):
                                need(time.monotonic()<self.deadline,'RESUME_PROGRAM_DEADLINE')
                                count+=len(data);need(count<=fact['bytes'],'RESUME_PROGRAM_READ_CHANGED');hasher.update(data)
                            need(count==fact['bytes'] and hasher.hexdigest() == fact['sha256'],
                                 'RESUME_PROGRAM_BYTES_CHANGED')
                    need(signature(os.fstat(fd)) == signature(info), 'RESUME_PROGRAM_READ_CHANGED')
                    identities[path] = signature(info)
                finally: os.close(fd)
            for path, target in value['links'].items():
                need(Path(path).is_relative_to(value['console']) and type(target) is str and
                     (Path(path).parent/target).resolve(strict=True).is_relative_to(value['console']),
                     'RESUME_PROGRAM_LINK')
                fd = open_in_root(root,path,path_link=True)
                try:
                    info=os.fstat(fd)
                    need(stat.S_ISLNK(info.st_mode) and info.st_uid == root_uid and
                         os.readlink('',dir_fd=fd) == target, 'RESUME_GUEST_PROGRAM_LINK')
                    identities[path] = signature(info)
                finally: os.close(fd)
            return identities
        finally: os.close(root)

    def assert_process(self, credentials, stage):
        pid, uid, gid = credentials
        need(stage == 'node' and credentials == self.credentials and uid == os.getuid() == self.broker.config['uid'] and
             gid == self.broker.config['gid'], 'RESUME_WEBSITE_PEER')
        self.inspect(); peer=read_proc(pid)
        need(peer == self.node_process and peer['namespaces'] == self.initial['namespaces'], 'RESUME_NODE_CHANGED')
        current=peer
        for _ in range(32):
            if current['pid'] == self.initial['pid']: break
            need(current['parent'] > 1 and current['parent'] != current['pid'], 'RESUME_NODE_ANCESTRY')
            current=read_proc(current['parent'])
        else: need(False,'RESUME_NODE_ANCESTRY')
        with (Path('/proc')/str(pid)/'cmdline').open('rb') as stream:argv=stream.read(65537)
        need(len(argv)<=65536,'RESUME_NODE_ARGV_BOUND')
        allowed = selected_programs(self.manifest, self.initial_item['Config']['Cmd'])
        need(argv in [b'\0'.join(x.encode() for x in program)+b'\0' for program in allowed] and
             peer['exe'] == self.code_identities[str(self.executable)][:2], 'RESUME_NODE_PROGRAM')
        with (Path('/proc')/str(pid)/'status').open('rb') as stream:status=stream.read(65537)
        need(len(status)<=65536,'RESUME_NODE_STATUS_BOUND');status=status.decode('ascii')
        fields=dict(line.split(':',1) for line in status.splitlines() if ':' in line)
        need(all(int(fields[k].strip(),16)==0 for k in ('CapInh','CapPrm','CapEff','CapAmb')),
             'RESUME_NODE_PRIVILEGE')
        need([int(x) for x in fields['Uid'].split()]==[uid]*4 and
             [int(x) for x in fields['Gid'].split()]==[gid]*4,'RESUME_NODE_CREDENTIALS_CHANGED')
        need(read_proc(pid)==peer, 'RESUME_NODE_RACE')
        return peer

    def final_code(self, *, deadline=None):
        need(deadline is None or type(deadline)in(int,float)and math.isfinite(deadline),'RESUME_PEER_DEADLINE')
        self.deadline = min(time.monotonic() + 60,deadline)if deadline is not None else time.monotonic()+60
        need(self.qualify_code() == self.code_identities, 'RESUME_PROGRAM_GRAPH_CHANGED')
        need(self.qualify_socket()==self.socket_identity,'RESUME_GUEST_SOCKET_CHANGED')
        self.assert_process(self.credentials,'node')
        need(time.monotonic()<self.deadline,'RESUME_PEER_DEADLINE')
