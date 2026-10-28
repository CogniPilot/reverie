"""Fixed owner-local H website rendezvous, not a browser/worker authority API.

Canonical website tooling owns create/start. This helper accepts only its exact
stopped result while the SAME maintenance OFD is held. Static owner choices live
in one private installation; each run gets a fresh H policy/ledger generation.
There is no automatic retry, old capability restoration or employee operation.
"""
from contextlib import contextmanager, nullcontext
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import stat
import subprocess
import time
import uuid

from .owner_terminal_native import private_document, private_bytes, physical, exact, inventory, overlap, stamp as _native_stamp
from .owner_terminal_channel import need, read_proc, Program
from .owner_terminal_host import exclusive
from .human_shell_capabilities import open_directory
from .website_peer_facts import Engine, WebsiteFacts, digest, mounts, host_config

PURPOSE='reverie-owner-terminal-lifecycle-v1'
UNIT='reverie-owner-terminal.service'
SHA=re.compile(r'[a-f0-9]{64}\Z')
CID=SHA
CONTROL_CURRENT='current-generation.json'
CONTROL_PENDING='generation.pending.json'
CGROUP=Path('/sys/fs/cgroup')
PROC=Path('/proc')
RUNTIME_ROOT=Path('/run/user')


def _sha(raw):return hashlib.sha256(raw).hexdigest()


def _immutable(pair,maximum=1<<20):
    exact(pair,('path','sha256'));need(type(pair['sha256']) is str and SHA.fullmatch(pair['sha256']),
                                    'H_LIFECYCLE_IMMUTABLE_PAIR')
    path=physical(pair['path']);info=path.stat()
    need(str(path).startswith('/nix/store/') and stat.S_ISREG(info.st_mode) and info.st_uid==0 and
         not info.st_mode&0o222 and 0<info.st_size<=maximum,'H_LIFECYCLE_IMMUTABLE_PAIR')
    total=0;hasher=hashlib.sha256();parts=[]
    with path.open('rb') as stream:
        while chunk:=stream.read(1<<20):
            total+=len(chunk);need(total<=maximum,'H_LIFECYCLE_IMMUTABLE_CHANGED');hasher.update(chunk)
            if maximum<=4<<20:parts.append(chunk)
    raw=b''.join(parts)
    need(total==info.st_size and hasher.hexdigest()==pair['sha256'],'H_LIFECYCLE_IMMUTABLE_CHANGED')
    return path,raw


def _json(raw):
    def unique(pairs):
        out={}
        for key,value in pairs:
            need(key not in out,'H_LIFECYCLE_DUPLICATE_KEY');out[key]=value
        return out
    return json.loads(raw,object_pairs_hook=unique,
                      parse_constant=lambda _:(_ for _ in ()).throw(ValueError('H_LIFECYCLE_NONFINITE')))


def _encoded(value):return (json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()


def _stamp(path):
    value=path.lstat()
    return (value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_gid,
            value.st_nlink,value.st_size,value.st_mtime_ns,value.st_ctime_ns)


class RuntimeManifest:
    """Immutable package facts, supplied literally by the fixed Nix launcher."""
    FIELDS={'version','purpose','profile','hostProgram','systemctl','engineProgram','websiteProgram','imageProvenance','toolkitManifest'}
    def __init__(self,pair):
        self.pair=copy.deepcopy(pair);self.path,raw=_immutable(pair);self.value=_json(raw)
        value=self.value;exact(value,self.FIELDS)
        need(value['version']==1 and type(value['version']) is int and
             value['purpose']=='owner-terminal-lifecycle-runtime-v1' and value['profile'] in ('terminal','resource-terminal'),
             'H_LIFECYCLE_RUNTIME_SCHEMA')
        self.program=_json(_immutable(value['websiteProgram'])[1])
        need(self.program.get('version')==1 and self.program.get('purpose')=='owner-terminal-website-program-v1',
             'H_LIFECYCLE_PROGRAM_MANIFEST_REQUIRED')
        self.provenance_path,_raw=_immutable(value['imageProvenance'])
        self.systemctl=_immutable(value['systemctl'],256<<20)[0]
        self.engine_program=_immutable(value['engineProgram'],256<<20)[0]
        self.host_program=copy.deepcopy(value['hostProgram'])
        exact(self.host_program,('executable','argvPrefix'))
        prefix=self.host_program['argvPrefix'];entry=Path(__file__).resolve().parents[2]/'scripts/reverie-owner-terminal-host'
        need(type(prefix) is list and len(prefix)==4 and prefix[1:]==['-I','-B',str(entry)] and
             str(entry).startswith('/nix/store/') and Path(prefix[0]).resolve(strict=True)==Path(self.host_program['executable']),
             'H_LIFECYCLE_FIXED_HOST_PROGRAM_REQUIRED')
        for path in (Path(self.host_program['executable']),entry):
            info=path.stat();need(info.st_uid==0 and not info.st_mode&0o222 and stat.S_ISREG(info.st_mode),
                                 'H_LIFECYCLE_FIXED_HOST_PROGRAM_REQUIRED')


class InitialInstallation:
    """Existing private owner selection; never manufactured from request JSON."""
    FIELDS={'version','purpose','workerConfig','engine','deploymentPath','lockPath','controlBase','ledgerBase','bootstrapRoot',
            'entitlements','externalOrigin','ingressPeers'}
    def __init__(self,path,runtime):
        need(type(runtime) is RuntimeManifest,'H_LIFECYCLE_FIXED_RUNTIME_REQUIRED');self.runtime=runtime
        self.path=physical(path);self.value,self.identity=private_document(self.path)
        value=self.value;exact(value,self.FIELDS)
        need(value['version']==1 and type(value['version']) is int and value['purpose']==PURPOSE,
             'H_LIFECYCLE_INSTALLATION_SCHEMA')
        need(type(value['entitlements']) is list and 1<=len(value['entitlements'])<=128 and
             len(set(value['entitlements']))==len(value['entitlements']) and
             all(type(eid) is str and str(uuid.UUID(eid))==eid for eid in value['entitlements']),
             'H_LIFECYCLE_STATIC_EID_ENTITLEMENTS_REQUIRED')
        self.roots={name:physical(value[name]) for name in ('controlBase','ledgerBase','bootstrapRoot')}
        need(self.path.parent==self.roots['controlBase'],'H_LIFECYCLE_INSTALLATION_DIRECTORY')
        need(all(not overlap(a,b) for i,a in enumerate(self.roots.values())
                 for j,b in enumerate(self.roots.values()) if i<j),'H_LIFECYCLE_ROOT_OVERLAP')
        self.root_ids={}
        for name,path in self.roots.items():
            fd=open_directory(path)
            try:
                info=os.fstat(fd)
                need(stat.S_IMODE(info.st_mode)==0o700 and info.st_uid==os.getuid(),
                     'H_LIFECYCLE_PRIVATE_ROOT')
                if name!='bootstrapRoot':
                    need(not any(path.is_relative_to(base) for base in ('/tmp','/var/tmp','/run','/dev')),
                         'H_LIFECYCLE_DURABLE_ROOT_REQUIRED')
                else:
                    need(not any(path.is_relative_to(base) for base in ('/tmp','/var/tmp')),
                         'BOOTSTRAP_MUST_SURVIVE_PRIVATE_TMP_NAMESPACE')
                self.root_ids[name]=(info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)
            finally:os.close(fd)
        exact(value['engine'],('socket','identity','id'))
        self.engine=Engine(value['engine']['socket'],value['engine']['identity'],value['engine']['id'])
        self.lock_path=Path(value['lockPath'])
        need(self.lock_path.is_absolute() and '..' not in self.lock_path.parts and
             self.lock_path.parent.resolve(strict=True)==self.lock_path.parent,'H_LIFECYCLE_MAINTENANCE_LOCK_REQUIRED')
        self.deployment_path=physical(value['deploymentPath'])
        need(self.lock_path.name=='update.lock',
             'H_LIFECYCLE_MAINTENANCE_LOCK_REQUIRED')
        self.program=runtime.program;self.systemctl=runtime.systemctl;self.engine_program=runtime.engine_program
        self.host_program=runtime.host_program
        self.guard()

    def guard(self):
        value,identity=private_document(self.path)
        need(value==self.value and identity==self.identity,'H_LIFECYCLE_INSTALLATION_CHANGED')
        for name,path in self.roots.items():
            info=path.lstat()
            need(stat.S_ISDIR(info.st_mode) and (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)==self.root_ids[name],
                 'H_LIFECYCLE_ROOT_CHANGED')
        from .worker import load_config
        selection=private_bytes(self.value['workerConfig'])
        config=load_config(self.value['workerConfig'])
        need(config['uid']==os.getuid() and config['gid']==os.getgid() and os.getuid()>0,
             'H_LIFECYCLE_OWNER_CONFIG_REQUIRED')
        from .owner_terminal_resource_binding import require_disjoint_roots
        require_disjoint_roots(config,self.roots.values())
        before=inventory(self.engine)
        grants=[physical(config[name]) for name in ('stateRoot','companyRoot','scratchRoot','apiSocketRoot')]
        grants += [physical(row['source']) for row in config['mounts']]
        configured=list(grants)
        for row in before:
            for mount in row['Mounts']:
                if mount.get('Type')=='bind':
                    grant=physical(mount['Source']);grants.append(grant)
                    if overlap(grant,self.roots['bootstrapRoot']):
                        need(grant==self.roots['bootstrapRoot'] and mount.get('Destination')=='/run/reverie-owner-terminal'
                             and mount.get('RW') is False and not (row.get('Labels') or {}).get('reverie.worker'),
                             'H_LIFECYCLE_BOOTSTRAP_EXPOSED')
        from .worker_cold_tmp import read_mount_table,refuse_host_mount_aliases
        table=read_mount_table()
        # Bootstrap is the single explicit RO website grant. All OTHER roots,
        # the installation, lock and worker config remain outside every bind.
        protected=[self.roots['controlBase'],self.roots['ledgerBase'],self.path,
                   physical(self.value['workerConfig']),self.lock_path,Path.home()/'.config/systemd/user'/UNIT]
        for path in protected:
            for grant in grants:
                need(not overlap(path,grant),'H_LIFECYCLE_CONTROL_EXPOSED')
                refuse_host_mount_aliases(path,grant,table)
        for grant in configured:
            need(not overlap(self.roots['bootstrapRoot'],grant),'H_LIFECYCLE_BOOTSTRAP_EXPOSED')
            refuse_host_mount_aliases(self.roots['bootstrapRoot'],grant,table)
        need(inventory(self.engine)==before and read_mount_table()==table,'H_LIFECYCLE_INVENTORY_CHANGED')
        self.engine.guard()
        require_disjoint_roots(config,self.roots.values())
        need(private_bytes(self.value['workerConfig'])==selection,'H_LIFECYCLE_WORKER_CONFIG_CHANGED')
        self.worker_selection=selection
        return config

    @contextmanager
    def maintenance(self,fd):
        need(type(fd) is int and fd>=3,'H_LIFECYCLE_INHERITED_LOCK_REQUIRED')
        named=self.lock_path.lstat();held=os.fstat(fd)
        need(stat.S_ISREG(named.st_mode) and named.st_uid==os.getuid() and stat.S_IMODE(named.st_mode)==0o600 and
             named.st_nlink==1 and (held.st_dev,held.st_ino)==(named.st_dev,named.st_ino),
             'H_LIFECYCLE_INHERITED_LOCK_CHANGED')
        probe=os.open(self.lock_path,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            try:fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:pass
            else:
                fcntl.flock(probe,fcntl.LOCK_UN)
                raise ValueError('H_LIFECYCLE_LOCK_NOT_ALREADY_HELD')
            # A different OFD holding the lock also refuses: only the inherited
            # owner OFD can successfully confirm its exclusive ownership here.
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally:os.close(probe)
        self.guard()
        try:yield
        finally:
            again=self.lock_path.lstat()
            need((again.st_dev,again.st_ino)==(held.st_dev,held.st_ino),
                 'H_LIFECYCLE_INHERITED_LOCK_CHANGED')
        # Caller owns the inherited maintenance OFD; never close or unlock it.

    def current(self):
        path=self.roots['controlBase']/CONTROL_CURRENT
        value,identity=private_document(path)
        policy,signature=self._record(value)
        need(not os.path.lexists(self.roots['controlBase']/CONTROL_PENDING),'H_LIFECYCLE_TRANSITION_UNKNOWN')
        return value,policy,(identity,signature)

    def _record(self,value):
        exact(value,('version','generation','policyPath','policySHA256','runtimeManifest','unitSHA256','containerId','specSHA256','predecessor'))
        need(value['version']==1 and type(value['version']) is int and
             SHA.fullmatch(value['unitSHA256']) and SHA.fullmatch(value['specSHA256']) and
             CID.fullmatch(value['containerId']),'H_LIFECYCLE_CURRENT_SCHEMA')
        exact(value['runtimeManifest'],('path','sha256'))
        if value['predecessor'] is not None:exact(value['predecessor'],('path','sha256'))
        generation=str(uuid.UUID(value['generation']))
        need(generation==value['generation'] and
             value['policyPath']==str(self.roots['controlBase']/generation/'installation.json') and
             SHA.fullmatch(value['policySHA256']),'H_LIFECYCLE_CURRENT_SCHEMA')
        policy,signature=private_document(value['policyPath'],value['policySHA256'])
        need(policy['controlRoot']==str(self.roots['controlBase']/generation) and
             policy['ledgerRoot']==str(self.roots['ledgerBase']/generation) and
             policy['bootstrapRoot']==str(self.roots['bootstrapRoot']) and
             policy['website']['containerId']==value['containerId'], 'H_LIFECYCLE_GENERATION_ROOTS')
        return policy,signature

    def enabled(self):
        deployment,_signature=private_document(self.deployment_path)
        return (deployment.get('websiteRuntime')==self.runtime.value['profile'] and
                deployment.get('ownerTerminalConfig')==str(self.path))

    def owner_files(self):
        """Pin current owner mode before phase-native producers can block."""
        files={self.path:private_bytes(self.path),self.deployment_path:private_bytes(self.deployment_path),
            Path(self.value['workerConfig']):self.worker_selection}
        need(_json(files[self.path][0])==self.value and files[self.path][1]==self.identity,
             'H_LIFECYCLE_INSTALLATION_CHANGED')
        mode=_json(files[self.deployment_path][0])
        need(mode.get('websiteRuntime')==self.runtime.value['profile'] and
             mode.get('ownerTerminalConfig')==str(self.path),'H_LIFECYCLE_OWNER_MODE_CHANGED')
        return files

    def phase_files(self,selected):
        files=self.owner_files()
        files[self.roots['controlBase']/CONTROL_CURRENT]=private_bytes(self.roots['controlBase']/CONTROL_CURRENT)
        files[Path(selected['policyPath'])]=private_bytes(selected['policyPath'])
        need(_json(files[self.roots['controlBase']/CONTROL_CURRENT][0])==selected and
             _sha(files[Path(selected['policyPath'])][0])==selected['policySHA256'],
             'H_LIFECYCLE_CURRENT_CHANGED')
        return files

    def phase_roots(self,policy=None):
        # Initial roots retain their constructor identity. Selected generation
        # roots are captured before phase-native work, never refreshed after it.
        roots={path:self.root_ids[name] for name,path in self.roots.items()}
        if policy is not None:
            for name in ('controlRoot','ledgerRoot'):
                path=Path(policy[name]);roots[path]=_directory_identity(path)
        return roots

    def describe(self,fd=None):
        with self.maintenance(fd) if fd is not None else nullcontext():
            self.guard()
            from .resource_actor_install import artifact
            provenance=artifact(self.runtime.value['imageProvenance'])
            profile=provenance['imageSpec']['Config']
            parent=self.lock_path.parent.lstat()
            need(stat.S_ISDIR(parent.st_mode) and parent.st_uid==os.getuid() and
                 stat.S_IMODE(parent.st_mode)==0o700,'H_LIFECYCLE_MAINTENANCE_LOCK_REQUIRED')
            lock=None
            if os.path.lexists(self.lock_path):
                selected=self.lock_path.lstat()
                need(stat.S_ISREG(selected.st_mode) and selected.st_uid==os.getuid() and
                     stat.S_IMODE(selected.st_mode)==0o600 and selected.st_nlink==1,
                     'H_LIFECYCLE_MAINTENANCE_LOCK_REQUIRED')
                lock={'device':str(selected.st_dev),'inode':str(selected.st_ino),'uid':selected.st_uid,
                      'gid':selected.st_gid,'mode':stat.S_IMODE(selected.st_mode)}
            return {'version':1,'purpose':PURPOSE,'installationSHA256':_sha(private_bytes(self.path)[0]),
                'enabled':self.enabled(),'hasGeneration':os.path.lexists(self.roots['controlBase']/CONTROL_CURRENT),
                'lockPath':str(self.lock_path),'lockIdentity':lock,
                'lockParentIdentity':{'device':str(parent.st_dev),'inode':str(parent.st_ino),'uid':parent.st_uid,
                                      'gid':parent.st_gid,'mode':stat.S_IMODE(parent.st_mode)},
                'bootstrapMount':{'Type':'bind','Source':str(self.roots['bootstrapRoot']),
                    'Target':'/run/reverie-owner-terminal','ReadOnly':True,'BindOptions':{'CreateMountpoint':False}},
                'profile':{'name':self.runtime.value['profile'],'imageProvenance':copy.deepcopy(self.runtime.value['imageProvenance']),
                    'websiteProgram':copy.deepcopy(self.runtime.value['websiteProgram']),
                    'Cmd':copy.deepcopy(profile.get('Cmd')),'Entrypoint':copy.deepcopy(profile.get('Entrypoint'))},
                'budgets':{'listenerSeconds':120,'handoffSeconds':120,'readySeconds':180},'workerEffects':False}

    def preflight_created(self,fd,cid,spec_path,spec_sha):
        """Read-only declared stopped-site budget check, never start permission."""
        end=time.monotonic()+30
        need(type(spec_sha) is str and SHA.fullmatch(spec_sha),'H_LIFECYCLE_SPEC_PAIR_REQUIRED')
        spec_path=physical(spec_path)
        with self.maintenance(fd):
            need(not os.path.lexists(self.roots['controlBase']/CONTROL_PENDING),'H_LIFECYCLE_TRANSITION_UNKNOWN')
            config=self.guard();entries=self.owner_files();roots=self.phase_roots()
            entries[spec_path]=_data_bytes(spec_path,8<<20,private=True)
            need(_sha(entries[spec_path][0])==spec_sha,'H_LIFECYCLE_SPEC_CHANGED')
            spec=_json(entries[spec_path][0]);selection=self.derive_policy(cid,spec,config)
            self.engine.guard()
            # Capacity is the last native producer; each canonical-site inspect
            # retains the actual full create/image binding selected above.
            self._website_capacity(config,cid,stopped=True,deadline=end,selection=selection)
        _terminal_files(entries,data_paths={spec_path:(8<<20,True)},root_identities=roots)
        need(time.monotonic()<end,'H_LIFECYCLE_CAPACITY_DEADLINE')
        return {'version':1,'state':'STOPPED_WEBSITE_CAPACITY_QUALIFIED','containerId':cid,
                'specSHA256':spec_sha,'workerEffects':False}

    def _website_capacity(self,config,cid,*,stopped,deadline,selection=None):
        from .worker_resource_reservations import NativeObserver,ReservationGate,configured,option
        probe=_CapacityProbe(config,self.engine,deadline,cid,selection)
        class StoppedObserver(NativeObserver):
            def capacity(self,rows,selected):
                return self.capacity_stopped_website(rows,selected,cid)
        native=StoppedObserver(probe) if stopped else NativeObserver(probe)
        native._local.deadline=deadline
        rows=native.inventory()
        if configured(config):
            gate=ReservationGate(probe);gate.native=native
            with gate.admission(deadline=deadline):
                # Fixed INSTALL proof qualifies every retained source/delta and
                # existing host-job fences. No claim, candidate SID or permit.
                first=gate.check_headroom()
                second=gate.check_headroom()
                need(first==second,'H_LIFECYCLE_CAPACITY_CHANGED')
        else:
            # A truly absent domain retains the conservative legacy margin,
            # now including the actual candidate's declared site ceiling.
            need(option(config) is None,'H_LIFECYCLE_CAPACITY_POLICY_REQUIRED')
            first=_legacy_website_capacity(native,rows,cid,stopped)
            need(native.inventory()==rows,'H_LIFECYCLE_CAPACITY_CHANGED')
            need(_legacy_website_capacity(native,rows,cid,stopped)==first,
                 'H_LIFECYCLE_CAPACITY_CHANGED')
            need(native.inventory()==rows,'H_LIFECYCLE_CAPACITY_CHANGED')
        # Admission exit includes native custody/finalizers. Their last complete
        # inventory must still match the snapshot used for both capacity proofs.
        need(native.inventory()==rows,'H_LIFECYCLE_CAPACITY_CHANGED')
        need(time.monotonic()<deadline,'H_LIFECYCLE_CAPACITY_DEADLINE')

    def prepare_created(self,fd,cid,spec_path,spec_sha):
        need(type(spec_sha) is str and SHA.fullmatch(spec_sha),'H_LIFECYCLE_SPEC_PAIR_REQUIRED')
        spec_path=physical(spec_path)
        with self.maintenance(fd):
            need(not os.path.lexists(self.roots['controlBase']/CONTROL_PENDING),'H_LIFECYCLE_TRANSITION_UNKNOWN')
            owner_entries=self.owner_files()
            self.require_old_settled()
            spec_selection=_data_bytes(spec_path,8<<20,private=True)
            need(_sha(spec_selection[0])==spec_sha,'H_LIFECYCLE_SPEC_CHANGED')
            spec=_json(spec_selection[0]);signature=spec_selection[1]
            config=self.guard();worker_selection=self.worker_selection
            selection=self.derive_policy(cid,spec,config)
            deployment,_d=private_document(self.deployment_path)
            need(deployment.get('ownerTerminalConfig')==str(self.path) and
                 deployment.get('websiteRuntime')==self.runtime.value['profile'] and
                 selection['containerId']==cid,'H_LIFECYCLE_DEPLOYMENT_SELECTION_CHANGED')
            generation=str(uuid.uuid4())
            control=self.roots['controlBase']/generation;ledger=self.roots['ledgerBase']/generation
            # Exclusive namespace creation is consumed even on a partial failure.
            control.mkdir(mode=0o700);ledger.mkdir(mode=0o700)
            anchored_roots=self.phase_roots()
            anchored_roots.update({path:_directory_identity(path) for path in (control,ledger)})
            company_selection=_data_bytes(config['companyFile'],16<<20)
            company=_json(company_selection[0]);_company_signature=company_selection[1]
            employees=company.get('employees')
            need(type(employees) is list,'H_LIFECYCLE_CURRENT_COMPANY_REQUIRED')
            entitled={}
            for eid in self.value['entitlements']:
                rows=[e for e in employees if e.get('id')==eid]
                need(len(rows)==1 and type(rows[0].get('sessionGeneration')) is int and
                     rows[0]['sessionGeneration']>=0,'H_LIFECYCLE_CURRENT_EMPLOYEE_REQUIRED')
                sid=rows[0].get('sessionId');need(type(sid) is str and str(uuid.UUID(sid))==sid,
                                               'H_LIFECYCLE_CURRENT_EMPLOYEE_REQUIRED')
                entitled[eid]={'sessionId':sid,'generation':rows[0]['sessionGeneration']}
            policy={'version':1,'workerConfig':self.value['workerConfig'],'workerConfigSHA256':_sha(worker_selection[0]),
                'engineSocket':self.value['engine']['socket'],'engineSocketIdentity':self.value['engine']['identity'],
                'engineId':self.value['engine']['id'],'website':selection,'controlRoot':str(control),
                'ledgerRoot':str(ledger),'bootstrapRoot':str(self.roots['bootstrapRoot']),
                'entitlements':entitled,
                'hostProgram':{'executable':self.host_program['executable'],
                    'argv':self.host_program['argvPrefix']+['--policy',str(control/'installation.json')]},
                'engineProgram':str(self.engine_program),'externalOrigin':self.value['externalOrigin'],
                'ingressPeers':copy.deepcopy(self.value['ingressPeers']),
                'toolkitManifest':copy.deepcopy(self.runtime.value['toolkitManifest'])}
            from . import owner_terminal_resource_binding as resource
            resource_binding=(resource.capture(config,self.value['workerConfig'],self.engine)
                              if resource.R.configured(config) else None)
            if resource_binding is not None:
                policy['version']=2
                policy['resourceBinding']=resource_binding
                policy['entitlements']={eid:{'binding':'current','ownerDigest':digest({'owner':next(
                    row for row in employees if row.get('id')==eid).get('owner')})} for eid in entitled}
                # Canonical semantic baseline, independent of whitespace in the
                # actual private source file. Current bytes still bracketed below.
                policy['workerConfigSHA256']=_sha(resource.J.encode(config))
            from .owner_terminal_native import Installation
            raw=_encoded(policy);policy_path=control/'installation.json';exclusive(policy_path,raw)
            # Real existing-only constructor accepts stopped/null-init selection.
            # It validates static private policy, toolkit and all custody facts.
            checked=Installation(policy_path,_sha(raw))
            try:checked.guard()
            finally:checked.close()
            unit_raw=self.unit_text()
            record={'version':1,'generation':generation,'policyPath':str(policy_path),'policySHA256':_sha(raw),
                'runtimeManifest':self.runtime.pair,'unitSHA256':_sha(unit_raw),'containerId':cid,'specSHA256':spec_sha,
                'predecessor':None}
            pending=self.roots['controlBase']/CONTROL_PENDING
            old_path=self.roots['controlBase']/CONTROL_CURRENT
            old=private_bytes(old_path) if os.path.lexists(old_path) else None
            if old is not None:
                saved=self.roots['controlBase']/('generation-history-'+_sha(old[0])+'.json')
                if os.path.lexists(saved):need(private_bytes(saved)[0]==old[0],'H_LIFECYCLE_HISTORY_CHANGED')
                else:exclusive(saved,old[0])
                record['predecessor']={'path':str(saved),'sha256':_sha(old[0])}
            exclusive(pending,_encoded(record))
            self.install_unit(unit_raw,old)
            need(_data_bytes(spec_path,8<<20,private=True)==spec_selection,'H_LIFECYCLE_SPEC_CHANGED')
            need(self.guard()==config and self.worker_selection==worker_selection,
                 'H_LIFECYCLE_WORKER_CONFIG_CHANGED')
            need(self.derive_policy(cid,spec,config)==selection,'H_LIFECYCLE_CREATED_BINDING_CHANGED')
            need(_data_bytes(config['companyFile'],16<<20)==company_selection,
                 'H_LIFECYCLE_CURRENT_COMPANY_CHANGED')
            next_path=self.roots['controlBase']/'generation.next.json';exclusive(next_path,_encoded(record))
            need((private_bytes(old_path) if os.path.lexists(old_path) else None)==old,
                 'H_LIFECYCLE_CURRENT_CHANGED')
            os.replace(next_path,old_path);_sync(self.roots['controlBase'])
            current_selection=private_bytes(old_path);pending_selection=private_bytes(pending)
            need(current_selection[0]==pending_selection[0]==_encoded(record),'H_LIFECYCLE_PUBLICATION_CHANGED')
            self.guard()
            entries={old_path:current_selection,pending:pending_selection,policy_path:private_bytes(policy_path),
                     spec_path:spec_selection,Path(config['companyFile']):company_selection,
                     Path(self.value['workerConfig']):worker_selection}
            # Retain the admission snapshot even if a native producer changed
            # owner mode before a later metadata read could notice it.
            entries.update(owner_entries)
        _terminal_files(entries,data_paths={spec_path:(8<<20,True),Path(config['companyFile']):(16<<20,False)},
                        root_identities=anchored_roots)
        os.unlink(pending)
        return {'version':1,'generation':generation,'policyPath':str(policy_path),'policySHA256':_sha(raw),
                'containerId':cid,'listenerState':'NOT_STARTED','workerEffects':False}

    def unit_text(self):
        from .owner_terminal_install import quoted
        initial_sha=_sha(private_bytes(self.path)[0])
        from .owner_terminal_resource_binding import locking_paths,require_disjoint_roots
        config=private_document(self.value['workerConfig'])[0]
        lock_paths=locking_paths(config)
        require_disjoint_roots(config,self.roots.values())
        argv=self.host_program['argvPrefix']+['--installation',str(self.path),'--installation-sha',initial_sha]
        return ('\n'.join(['[Unit]','Description=Reverie protected owner human-terminal H service',
            # Per-generation START is the no-replay boundary. An infinite unit
            # rate limit would forbid every later CLEAN generation too.
            'StartLimitIntervalSec=0','[Service]','Type=simple','Restart=no','UMask=0077',
            'ExecStart='+' '.join(quoted(value) if value.startswith('/') else value for value in argv),
            'UnsetEnvironment=LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_ORIGIN_PATH GLIBC_TUNABLES GCONV_PATH BASH_ENV ENV PYTHONPATH PYTHONHOME NODE_OPTIONS NODE_PATH OPENSSL_CONF OPENSSL_MODULES',
            'NoNewPrivileges=true','ProtectSystem=strict','ProtectHome=read-only','PrivateTmp=true',
            'RestrictAddressFamilies=AF_UNIX','MemoryMax=256M','MemorySwapMax=0','TasksMax=64',
            'TimeoutStopSec=120','KillMode=control-group',
            'ReadWritePaths='+' '.join(quoted(str(path)) for path in [*self.roots.values(),*lock_paths]),
            '[Install]','WantedBy=default.target',''])).encode()

    def install_unit(self,raw,old_selection):
        unit=Path.home()/'.config/systemd/user'/UNIT
        directory=_unit_directory()
        try:
            existing=private_bytes(unit) if os.path.lexists(unit) else None
            if existing is not None and existing[0]==raw:return
            state=self.unit_state()
            need(state['MainPID']=='0' and state['ActiveState'] in ('inactive','failed'),
                 'H_LIFECYCLE_UNIT_MUST_BE_STOPPED')
            if existing is not None:
                need(old_selection is not None,'H_LIFECYCLE_FOREIGN_UNIT')
                old=_json(old_selection[0]);need(_sha(existing[0])==old['unitSHA256'],'H_LIFECYCLE_UNIT_CHANGED')
                history=self.roots['controlBase']/('unit-history-'+_sha(existing[0])+'.txt')
                if not os.path.lexists(history):exclusive(history,existing[0])
            next_path=unit.with_name(UNIT+'.next');exclusive(next_path,raw)
            need((private_bytes(unit) if os.path.lexists(unit) else None)==existing,'H_LIFECYCLE_UNIT_CHANGED')
            os.replace(next_path,unit);os.fsync(directory)
        finally:os.close(directory)
        # A fixed unit publication, not an arbitrary systemctl operation.
        code,_out,_err=_systemctl(self.systemctl,['daemon-reload'])
        need(code==0,'H_LIFECYCLE_UNIT_RELOAD_UNKNOWN')


    def manager(self,action):
        need(action in ('start','stop','show'),'H_LIFECYCLE_FIXED_SERVICE_ACTION')
        args=[action,UNIT]
        if action=='show':
            args+=['--property=LoadState,MainPID,ControlGroup,InvocationID,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,FragmentPath,DropInPaths']
        code,out,_err=_systemctl(self.systemctl,args)
        need(code==0 or action=='show' and code==4,
             'H_LIFECYCLE_SERVICE_UNCONFIRMED')
        return out.decode('utf8')

    def service_binding(self,state,policy):
        need(state['LoadState']=='loaded' and state['ActiveState']=='active' and state['SubState']=='running' and
             int(state['MainPID'])>1 and re.fullmatch('[a-f0-9]{32}',state['InvocationID']),
             'H_LIFECYCLE_RUNNING_SERVICE_REQUIRED')
        process=read_proc(int(state['MainPID']))
        Program(policy['hostProgram']['executable'],tuple(policy['hostProgram']['argv'])).matches(process)
        group=_group_binding(process['pid'])
        need(group['path']==state['ControlGroup'],'H_LIFECYCLE_SERVICE_CGROUP_CHANGED')
        leaf=CGROUP/group['path'].lstrip('/')
        for name,expected in (('memory.max','268435456'),('memory.swap.max','0'),('pids.max','64')):
            need(_read(leaf/name,128).strip()==expected,'H_LIFECYCLE_SERVICE_LIMIT_CHANGED')
        need(read_proc(process['pid'])==process and self.unit_state()==state,
             'H_LIFECYCLE_SERVICE_CHANGED')
        return {'process':process,'invocationId':state['InvocationID'],'cgroup':group,
                'unit':copy.deepcopy(state)}

    def require_old_settled(self,*,previous=None):
        current=self.roots['controlBase']/CONTROL_CURRENT
        if previous is None and not os.path.lexists(current):
            need(not os.path.lexists(self.roots['controlBase']/CONTROL_PENDING),'H_LIFECYCLE_TRANSITION_UNKNOWN')
            # Missing selector is initial only if no earlier generation exists.
            entries=list(self.roots['controlBase'].iterdir())
            need(len(entries)<=4096 and entries==[self.path], 'H_LIFECYCLE_MISSING_CURRENT_GENERATION')
            state=self.unit_state()
            need(state['MainPID']=='0' and state['ActiveState']=='inactive','H_LIFECYCLE_FOREIGN_SERVICE')
            return None
        if previous is None:
            selected,policy,signature=self.current()
        else:
            exact(previous,('path','sha256'))
            need(previous['path']==str(self.roots['controlBase']/('generation-history-'+previous['sha256']+'.json')) and
                 SHA.fullmatch(previous['sha256']),'H_LIFECYCLE_PREDECESSOR_CHANGED')
            selected,history_signature=private_document(previous['path'],previous['sha256'])
            policy,policy_signature=self._record(selected)
            signature=(history_signature,policy_signature)
        root=Path(policy['controlRoot'])
        anchored_roots=self.phase_roots(policy)
        files={root/'SERVICE-START.json':private_bytes(root/'SERVICE-START.json'),
               root/'HOST-DRAINED.json':private_bytes(root/'HOST-DRAINED.json'),
               Path(selected['policyPath']):private_bytes(selected['policyPath'])}
        started=_json(files[root/'SERVICE-START.json'][0])
        drained=_json(files[root/'HOST-DRAINED.json'][0])
        exact(drained,('schema','policySHA256','process','websiteBindingDigest','shutdown','settlements'))
        need(drained['schema']=='reverie-owner-terminal-drained-v1' and
             drained['policySHA256']==selected['policySHA256'] and
             digest(drained['process'])==digest(started['process']), 'H_LIFECYCLE_UNCONFIRMED_DRAIN')
        state=self.unit_state()
        requested=(drained['shutdown']=='REQUESTED' and state['ActiveState']=='inactive' and
                   state['Result']=='success' and state['ExecMainStatus']=='0')
        invalidated=(drained['shutdown']=='POLICY_INVALIDATED' and state['ActiveState']=='failed' and
                     state['Result']=='exit-code' and state['ExecMainStatus']=='1')
        # A clean inactive unit can be garbage-collected by the user manager.
        # Absence of retained manager history is NEVER cleanup authority: the
        # canonical drain and fresh complete PID/cgroup/guest facts below are
        # still mandatory. A different retained invocation always refuses.
        need(state['MainPID']=='0' and (requested or invalidated) and
             state['InvocationID'] in (started['invocationId'],''),
             'H_LIFECYCLE_UNCONFIRMED_SERVICE_STOP')
        need(_pid_gone(started['process']),'H_LIFECYCLE_HOST_PROCESS_REMAINS')
        _group_empty(started['cgroup'])
        # Canonical intent/ready/settled records are still necessary. Fresh
        # kernel absence below is independent; none is a restart capability.
        settlements=drained['settlements']
        need(type(settlements) is dict and len(settlements)<=256,'H_LIFECYCLE_DRAIN_BOUND')
        intents={}
        for count,path in enumerate(Path(policy['ledgerRoot']).iterdir(),1):
            need(count<=4096,'H_LIFECYCLE_LEDGER_BOUND')
            match=re.fullmatch('shell-([a-f0-9-]{36})[.]json',path.name)
            if match:
                shell=match[1];need(str(uuid.UUID(shell))==shell,'H_LIFECYCLE_SHELL_ID')
                files[path]=private_bytes(path);intents[shell]=_json(files[path][0])
        need(set(intents)==set(settlements),'H_LIFECYCLE_UNKNOWN_SHELL_INTENT')
        from . import owner_terminal_toolkit as toolkit
        for shell,proof_digest in settlements.items():
            need(type(proof_digest) is str and SHA.fullmatch(proof_digest),'H_LIFECYCLE_SETTLEMENT_CHANGED')
            native_path=Path(policy['ledgerRoot'])/('shell-'+shell+'-native-settled.json')
            files[native_path]=private_bytes(native_path)
            need(_sha(files[native_path][0])==proof_digest,'H_LIFECYCLE_SETTLEMENT_CHANGED')
            proof=_json(files[native_path][0])
            exact(proof,('target','ready','client','targetCgroup'))
            start=intents[shell]
            need(start.get('state')=='H_START_INTENT_NO_REPLAY' and start.get('target')==proof['target'],
                 'H_LIFECYCLE_SETTLEMENT_CHANGED')
            for suffix in ('-ready','-settled'):
                path=Path(policy['ledgerRoot'])/('shell-'+shell+suffix+'.json');files[path]=private_bytes(path)
            ready=_json(files[Path(policy['ledgerRoot'])/('shell-'+shell+'-ready.json')][0])
            done=_json(files[Path(policy['ledgerRoot'])/('shell-'+shell+'-settled.json')][0])
            need(ready.get('guest')==proof['ready'] and ready.get('target')==proof['target'] and
                 done=={'state':'H_GUEST_AND_CLIENT_SETTLED','clientPid':proof['client']['pid'],
                        'clientStart':proof['client']['start']},'H_LIFECYCLE_SETTLEMENT_CHANGED')
            need(_pid_gone(proof['client']),'H_LIFECYCLE_CLIENT_PROCESS_REMAINS')
            item=self.engine.get('/containers/'+proof['target']['containerId']+'/json')
            from .owner_terminal_native import target_signature
            if item['State']['Running']:
                need(target_signature(item)==proof['target']['signature'],'H_LIFECYCLE_TARGET_CHANGED')
                need(item['State']['Pid']==proof['target']['init']['pid'],'H_LIFECYCLE_TARGET_CHANGED')
                paths={name:Path(value['source']) for name,value in proof['target']['roots']['directories'].items()}
                custody=toolkit.StorageRootCustody(proof['target']['init'],paths)
                try:
                    need(custody.snapshot()==proof['target']['roots'],'H_LIFECYCLE_OLD_STORAGE_CHANGED')
                    toolkit.guest_gone(proof['target'],proof['ready'])
                    custody.assert_current()
                finally:custody.close()
            else:
                need(item['State']['Pid']==0 and _pid_gone(proof['target']['init']),
                     'H_LIFECYCLE_TARGET_STOP_UNKNOWN')
                # Compare the complete captured target configuration using its
                # original running incarnation, then prove that incarnation is
                # gone. A restarted same-CID process never takes this branch.
                old=copy.deepcopy(item)
                old['State']={**old['State'],'Running':True,'Pid':proof['target']['init']['pid']}
                need(target_signature(old)==proof['target']['signature'],'H_LIFECYCLE_TARGET_CHANGED')
                _group_empty(proof['targetCgroup'])
        need(not os.path.lexists(self.roots['bootstrapRoot']/'bootstrap.sock') and
             not os.path.lexists(self.roots['bootstrapRoot']/'current.pending'),
             'H_LIFECYCLE_BOOTSTRAP_UNKNOWN')
        if previous is None:
            need(self.current()==(selected,policy,signature),'H_LIFECYCLE_OLD_GENERATION_CHANGED')
        else:
            need(private_document(previous['path'],previous['sha256'])==(selected,signature[0]) and
                 private_document(selected['policyPath'],selected['policySHA256'])==(policy,signature[1]),
                 'H_LIFECYCLE_OLD_GENERATION_CHANGED')
        need(self.unit_state()==state,'H_LIFECYCLE_OLD_GENERATION_CHANGED')
        _terminal_files(files,root_identities=anchored_roots)
        return selected

    @contextmanager
    def _maintenance_idle(self,config,deadline):
        """Hold common admission through H drain; historical settled proof is allowed."""
        from .worker_resource_reservations import configured,ReservationGate
        from .worker_host_job import require_idle
        if not configured(config):
            yield
            return
        probe=_CapacityProbe(config,self.engine,deadline,None)
        gate=ReservationGate(probe)
        with gate.admission(deadline=deadline):
            require_idle(gate)
            need(not gate.active_operations(gate._document()),'H_LIFECYCLE_RESOURCE_WORK_ACTIVE')
            yield
            require_idle(gate)
            need(not gate.active_operations(gate._document()),'H_LIFECYCLE_RESOURCE_WORK_ACTIVE')

    def settle(self,fd):
        end=time.monotonic()+120
        with self.maintenance(fd),self._maintenance_idle(self.guard(),end):
            if not os.path.lexists(self.roots['controlBase']/CONTROL_CURRENT):
                self.require_old_settled()
                return {'version':1,'state':'INITIAL_EMPTY','workerEffects':False}
            selected,policy,selection=self.current();root=Path(policy['controlRoot'])
            attempt=root/'LIFECYCLE-STOP-ATTEMPT.json'
            state=self.unit_state()
            if state['MainPID']=='0':
                self.require_old_settled()
                return {'version':1,'state':'ALREADY_NATIVE_SETTLED','generation':selected['generation'],'workerEffects':False}
            binding=self.service_binding(state,policy)
            started,_=private_document(root/'SERVICE-START.json')
            need(digest(started)==digest(binding),'H_LIFECYCLE_SERVICE_CHANGED')
            exclusive(attempt,_encoded({'generation':selected['generation'],'binding':binding}))
            self.manager('stop')
            self.require_old_settled()
            return {'version':1,'state':'NATIVE_SETTLED','generation':selected['generation'],'workerEffects':False}

    def start_listener(self,fd):
        end=time.monotonic()+120
        with self.maintenance(fd):
            need(self.enabled(),'H_LIFECYCLE_OWNER_MODE_CHANGED')
            selected,policy,selection=self.current();root=Path(policy['controlRoot'])
            entries=self.phase_files(selected)
            anchored_roots=self.phase_roots(policy)
            need(selected['runtimeManifest']==self.runtime.pair,'H_LIFECYCLE_RUNTIME_CHANGED')
            need(not os.path.lexists(root/'START-ATTEMPT.json'),'H_LIFECYCLE_CONSUMED_GENERATION')
            state=self.unit_state()
            need(state['MainPID']=='0' and state['ActiveState'] in ('inactive','failed'),
                 'H_LIFECYCLE_SERVICE_ALREADY_ACTIVE')
            if selected['predecessor'] is not None:self.require_old_settled(previous=selected['predecessor'])
            unit=Path.home()/'.config/systemd/user'/UNIT
            entries[unit]=private_bytes(unit)
            need(_sha(entries[unit][0])==selected['unitSHA256']==_sha(self.unit_text()),
                 'H_LIFECYCLE_UNIT_CHANGED')
            exclusive(root/'LISTENER-START-ATTEMPT.json',_encoded({'generation':selected['generation'],
                      'containerId':selected['containerId'],'unitSHA256':selected['unitSHA256']}))
            self.manager('start')
            while True:
                need(time.monotonic()<end,'H_LIFECYCLE_LISTENER_DEADLINE')
                state=self.unit_state()
                need(state['ActiveState'] in ('active','activating'),'H_LIFECYCLE_LISTENER_FAILED')
                if state['ActiveState']=='active' and state['MainPID']!='0':
                    process=read_proc(int(state['MainPID']))
                    # The fixed selector execs the SAME process into --policy.
                    # Its brief initial argv is allowed only while waiting.
                    initial_argv=self.host_program['argvPrefix']+['--installation',str(self.path),
                                      '--installation-sha',_sha(private_bytes(self.path)[0])]
                    try:Program(policy['hostProgram']['executable'],tuple(policy['hostProgram']['argv'])).matches(process)
                    except ValueError:
                        Program(self.host_program['executable'],tuple(initial_argv)).matches(process)
                    else:
                        filename=self.roots['bootstrapRoot']/'bootstrap.sock'
                        if os.path.lexists(filename):
                            binding=self.service_binding(state,policy)
                            listener=_listener(binding['process'],filename)
                            need(self.current()==(selected,policy,selection),'H_LIFECYCLE_CURRENT_CHANGED')
                            need(time.monotonic()<end,'H_LIFECYCLE_LISTENER_DEADLINE')
                            exclusive(root/'SERVICE-START.json',_encoded(binding))
                            entries[root/'SERVICE-START.json']=private_bytes(root/'SERVICE-START.json')
                            break
                time.sleep(.02)
        _terminal_files(entries,root_identities=anchored_roots)
        need(time.monotonic()<end,'H_LIFECYCLE_LISTENER_DEADLINE')
        return {'version':1,'generation':selected['generation'],'containerId':selected['containerId'],
                'listenerState':'LISTENING','listenerDigest':digest(listener),'workerEffects':False}

    def await_ready(self,fd):
        end=time.monotonic()+180
        with self.maintenance(fd):
            need(self.enabled(),'H_LIFECYCLE_OWNER_MODE_CHANGED')
            selected,policy,selection=self.current();root=Path(policy['controlRoot'])
            entries=self.phase_files(selected)
            anchored_roots=self.phase_roots(policy)
            entries[root/'SERVICE-START.json']=private_bytes(root/'SERVICE-START.json')
            started,_start_signature=private_document(root/'SERVICE-START.json')
            need(_json(entries[root/'SERVICE-START.json'][0])==started,'H_LIFECYCLE_SERVICE_CHANGED')
            while True:
                need(time.monotonic()<end,'H_LIFECYCLE_READY_DEADLINE')
                state=self.unit_state();binding=self.service_binding(state,policy)
                need(digest(binding)==digest(started),'H_LIFECYCLE_SERVICE_CHANGED')
                connected=root/'HOST-CONNECTED.json'
                if os.path.lexists(connected):
                    receipt,receipt_signature=private_document(connected)
                    entries[connected]=private_bytes(connected)
                    need(_json(entries[connected][0])==receipt,'H_LIFECYCLE_CONNECTED_RECEIPT_CHANGED')
                    exact(receipt,('schema','policySHA256','process','websiteBindingDigest','nodeProcess'))
                    need(receipt['schema']=='reverie-owner-terminal-connected-v1' and
                         receipt['policySHA256']==selected['policySHA256'] and
                         digest(receipt['process'])==digest(binding['process']),
                         'H_LIFECYCLE_CONNECTED_RECEIPT_CHANGED')
                    from .owner_terminal_native import Installation,ProtectedWebsitePeer
                    installed=Installation(selected['policyPath'],selected['policySHA256'])
                    try:
                        actual=installed.bind_website_once()
                        need(digest(actual)==receipt['websiteBindingDigest'] and actual['containerId']==selected['containerId'],
                             'H_LIFECYCLE_WEBSITE_CHANGED')
                        node=receipt['nodeProcess']
                        peer=ProtectedWebsitePeer(installed)
                        current=peer.assert_process((node['pid'],os.getuid(),os.getgid()),'node')
                        need(digest(current)==digest(node),'H_LIFECYCLE_NODE_CHANGED')
                        projection,project_signature=private_document(self.roots['bootstrapRoot']/'current.json')
                        entries[self.roots['bootstrapRoot']/'current.json']=private_bytes(self.roots['bootstrapRoot']/'current.json')
                        need(_json(entries[self.roots['bootstrapRoot']/'current.json'][0])==projection,
                             'H_LIFECYCLE_PROJECTION_UNAVAILABLE')
                        need(projection.get('available') is True and type(projection.get('atEpochMs')) is int and
                             -100<=int(time.time()*1000)-projection['atEpochMs']<=2000 and
                             projection.get('externalOrigin')==self.value['externalOrigin'] and
                             projection.get('ingressPeers')==self.value['ingressPeers'],
                             'H_LIFECYCLE_PROJECTION_UNAVAILABLE')
                        need(not os.path.lexists(self.roots['bootstrapRoot']/'bootstrap.sock'),
                             'H_LIFECYCLE_BOOTSTRAP_NOT_RETIRED')
                        installed.assert_website()
                        need(self.service_binding(self.unit_state(),policy)==binding and
                             self.current()==(selected,policy,selection),'H_LIFECYCLE_FINAL_NATIVE_CHANGED')
                    finally:installed.close()
                    self._website_capacity(self.guard(),selected['containerId'],stopped=False,deadline=end)
                    _live_process(binding['process'],'H_LIFECYCLE_HOST_PROCESS_CHANGED')
                    _live_process(node,'H_LIFECYCLE_NODE_PROCESS_CHANGED')
                    need(private_document(connected)==(receipt,receipt_signature),
                         'H_LIFECYCLE_CONNECTED_RECEIPT_CHANGED')
                    break
                time.sleep(.02)
        # All producer and descriptor finalizers precede this finite metadata
        # bracket. External changes after their last observation are not made
        # atomic by a file receipt.
        _terminal_files(entries,root_identities=anchored_roots)
        need(time.monotonic()<end,'H_LIFECYCLE_READY_DEADLINE')
        return {'version':1,'generation':selected['generation'],'containerId':selected['containerId'],
                'state':'PROTECTED_WEBSITE_READY','workerEffects':False}

    def unit_state(self):
        values={}
        for line in self.manager('show').splitlines():
            key,separator,value=line.partition('=')
            need(separator and key not in values,'H_LIFECYCLE_CLOSED_UNIT_STATE');values[key]=value
        exact(values,('LoadState','MainPID','ControlGroup','InvocationID','ActiveState','SubState','Result',
                      'ExecMainCode','ExecMainStatus','FragmentPath','DropInPaths'))
        need(values['LoadState'] in ('loaded','not-found') and not values['DropInPaths'] and
             values['MainPID'].isdecimal() and values['ExecMainStatus'].isdecimal(),
             'H_LIFECYCLE_CLOSED_UNIT_STATE')
        if values['LoadState']=='not-found':
            need(values['MainPID']=='0' and not values['ControlGroup'] and
                 values['ActiveState']=='inactive' and not values['InvocationID'],
                 'H_LIFECYCLE_UNKNOWN_UNIT')
        else:
            unit=Path.home()/'.config/systemd/user'/UNIT
            need(Path(values['FragmentPath']).resolve(strict=True)==unit.resolve(strict=True),
                 'H_LIFECYCLE_FOREIGN_UNIT')
        return values

    def derive_policy(self,cid,spec,config):
        """Actual stopped create readback, immutable image+program provenance."""
        need(type(cid) is str and CID.fullmatch(cid),'H_LIFECYCLE_EXACT_CID_REQUIRED')
        item=self.engine.get('/containers/'+cid+'/json')
        need(item['Id']==cid and item['State']['Running'] is False and item['State']['Pid']==0 and
             item.get('Name')=='/'+config['serverContainer'] and
             not item['State'].get('Paused') and not item['State'].get('Restarting') and
             not (item['Config'].get('Labels') or {}).get('reverie.worker'),'H_LIFECYCLE_STOPPED_WEBSITE_REQUIRED')
        need(type(spec) is dict and 'HostConfig' in spec and spec.get('Image')==item['Image'],
             'H_LIFECYCLE_FULL_SPEC_REQUIRED')
        # Reuse canonical website verification, rather than a raw-Docker oracle.
        path=Path(__file__).resolve().parents[2]/'apps/host/website-update.py'
        loader=importlib.util.spec_from_file_location('_h_website_stage',path)
        module=importlib.util.module_from_spec(loader);loader.loader.exec_module(module)
        module.WebsiteStage._verify_created(None,item,{'oldId':'0'*64,'newImage':item['Image'],'spec':spec},module.mounts(item))
        from .resource_actor_install import artifact
        from .website_image_provenance import verify_image_spec
        provenance=artifact(self.runtime.value['imageProvenance'])
        need(verify_image_spec(provenance,self.engine.get('/images/'+item['Image']+'/json'))==item['Image'],
             'H_LIFECYCLE_IMAGE_PROVENANCE_CHANGED')
        for name in ('Cmd','Entrypoint'):
            need(item['Config'].get(name)==provenance['imageSpec']['Config'].get(name),
                 'H_LIFECYCLE_FIXED_WEBSITE_STARTUP_REQUIRED')
        from .website_peer_facts import protected_backend
        protected_backend(item)
        boot=[mount for mount in item['Mounts'] if mount.get('Destination')=='/run/reverie-owner-terminal']
        need(len(boot)==1 and boot[0].get('Type')=='bind' and boot[0].get('RW') is False and
             physical(boot[0]['Source'])==self.roots['bootstrapRoot'],'H_LIFECYCLE_FIXED_BOOTSTRAP_MOUNT_REQUIRED')
        program=self.program;need(all(provenance['codeFiles'].get(key)==value for key,value in program['codeFiles'].items()),
                                 'H_LIFECYCLE_PROGRAM_IMAGE_MISMATCH')
        selection={'containerId':cid,'imageId':item['Image'],'configDigest':digest(item['Config']),
            'hostConfigDigest':digest(host_config(item['HostConfig'])),'mountsDigest':digest(mounts(item['Mounts'])),
            'initPid':None,'initStart':None,'uid':config['uid'],'gid':config['gid'],
            'bootstrap':{'executable':program['startupPython']['executable'],'argv':program['startupPython']['argvPrefix']},
            'node':{'executable':program['nodeExecutable'],'argv':program['argvPrefix']},'codeFiles':program['codeFiles']}
        WebsiteFacts(self.engine,selection)  # Closed input checks; no bind/Running claim.
        return selection


class _CapacityProbe:
    """Closed metadata GET adapter; no engine CLI, worker constructor or mutations."""
    def __init__(self,config,engine,deadline,cid,selection=None):
        self.config,self.engine,self.deadline,self.cid=config,engine,deadline,cid
        self.selection=selection
    def run_engine(self,args,optional=False,*,deadline=None):
        from .worker_resource_reservations import ENGINE_FORMAT,MAX_CONTAINERS,MAX_NATIVE_BYTES
        end=min(self.deadline,deadline) if deadline is not None else self.deadline
        need(time.monotonic()<end,'H_LIFECYCLE_CAPACITY_DEADLINE')
        if args==['ps','-aq','--no-trunc']:
            rows=self.engine.get('/containers/json?all=1')
            need(type(rows) is list and len(rows)<=MAX_CONTAINERS,'H_LIFECYCLE_CAPACITY_INVENTORY')
            ids=[row.get('Id') for row in rows]
            need(all(type(cid) is str and CID.fullmatch(cid) for cid in ids) and len(ids)==len(set(ids)),
                 'H_LIFECYCLE_CAPACITY_INVENTORY')
            raw='\n'.join(ids)
        else:
            need(type(args) is list and 4<=len(args)<=35 and args[:3]==['inspect','--format',ENGINE_FORMAT] and
                 all(type(cid) is str and CID.fullmatch(cid) for cid in args[3:]),
                 'H_LIFECYCLE_CAPACITY_METADATA_ONLY')
            output=[]
            for cid in args[3:]:
                need(time.monotonic()<end,'H_LIFECYCLE_CAPACITY_DEADLINE')
                row=self.engine.get('/containers/'+cid+'/json')
                need(row.get('Id')==cid and (self.cid is None or row.get('Name')!='/'+self.config['serverContainer'] or cid==self.cid),
                     'H_LIFECYCLE_CAPACITY_INVENTORY')
                if row.get('Name')=='/'+self.config['serverContainer'] and self.selection is not None:
                    selected=self.selection
                    need(row['Image']==selected['imageId'] and digest(row['Config'])==selected['configDigest'] and
                         digest(host_config(row['HostConfig']))==selected['hostConfigDigest'] and
                         digest(mounts(row['Mounts']))==selected['mountsDigest'],
                         'H_LIFECYCLE_CREATED_BINDING_CHANGED')
                # Keep every Mount/limit/state fact; do not return Env/argv.
                value={key:row[key] for key in ('Id','Name','Image','State','Mounts','HostConfig')}
                value['Config']={'Labels':row['Config'].get('Labels')}
                output.append(json.dumps(value,separators=(',',':'),allow_nan=False))
            raw='\n'.join(output)
        need(len(raw.encode())<=MAX_NATIVE_BYTES and time.monotonic()<end,'H_LIFECYCLE_CAPACITY_DEADLINE')
        return subprocess.CompletedProcess(args,0,raw,'')


def _legacy_website_capacity(native,rows,cid,stopped):
    from .worker_resource_reservations import MIB
    from .worker_capacity_policy import legacy_headroom_fits,pool_headroom_fits,GIB
    config=native.broker.config;host=native.host_root()
    sites=[row for row in rows if row.get('Name')=='/'+config['serverContainer']]
    need(len(sites)==1 and sites[0].get('Id')==cid,'H_LIFECYCLE_CAPACITY_WEBSITE_CHANGED')
    if stopped:
        memory,site=native.stopped_website_limits(sites[0],cid)
    else:memory,site=native.limits(sites[0])
    commitments=[]
    for row in rows:
        labels=row.get('Config',{}).get('Labels') or {};state=row.get('State',{})
        need(type(labels) is dict and type(state.get('Running')) is bool,'RESERVATION_NATIVE_STATE')
        if state['Running'] and any(key in labels for key in ('reverie.worker','reverie.nix-prepare')):
            commitments.append(native.limits(row)[1])
    budget=config['poolMemoryMiB']*MIB;total=sum(row['memory'] for row in commitments)
    need(legacy_headroom_fits(budget+memory,host['MemTotal']) and host['MemAvailable']>=8*GIB,
         'H_LIFECYCLE_LEGACY_HOST_BUDGET')
    need(pool_headroom_fits(budget_bytes=budget,committed_bytes=total,retained_bytes=0,candidate_bytes=0),
         'RESERVATION_CAPACITY_EXHAUSTED')
    return budget,total,site,commitments


def _live_process(expected,code):
    """Final finite kernel leaf check; never a new service/engine observation loop."""
    try:actual=read_proc(expected['pid'])
    except (OSError,ValueError) as error:raise ValueError(code) from error
    need(digest(actual)==digest(expected),code)


def _sync(root):
    fd=open_directory(root)
    try:os.fsync(fd)
    finally:os.close(fd)


def _read(path,limit):
    with Path(path).open('rb') as stream:raw=stream.read(limit+1)
    need(len(raw)<=limit,'H_LIFECYCLE_KERNEL_BOUND')
    return raw.decode('ascii')


def _systemctl(program,args):
    """Only fixed callers above choose args; bounded own tool, no shell."""
    root=RUNTIME_ROOT/str(os.getuid());info=root.lstat();bus=root/'bus';endpoint=bus.lstat()
    need(root.resolve(strict=True)==root and stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid() and
         stat.S_IMODE(info.st_mode)==0o700 and stat.S_ISSOCK(endpoint.st_mode) and endpoint.st_uid==os.getuid(),
         'H_LIFECYCLE_ORDINARY_USER_BUS_REQUIRED')
    env={'PATH':str(program.parent),'LANG':'C','LC_ALL':'C','XDG_RUNTIME_DIR':str(root),
         'DBUS_SESSION_BUS_ADDRESS':'unix:path='+str(bus)}
    child=subprocess.Popen([str(program),'--user',*args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE,env=env,start_new_session=True)
    seconds=120 if args and args[0]=='stop' else 30
    end=time.monotonic()+seconds;outputs={child.stdout:bytearray(),child.stderr:bytearray()};total=0
    try:
        with selectors.DefaultSelector() as selected:
            for stream in outputs:selected.register(stream,selectors.EVENT_READ)
            while selected.get_map():
                need(time.monotonic()<end,'H_LIFECYCLE_SERVICE_DEADLINE')
                for key,_events in selected.select(max(.001,min(.5,end-time.monotonic()))):
                    chunk=os.read(key.fileobj.fileno(),4096)
                    if not chunk:selected.unregister(key.fileobj)
                    else:
                        total+=len(chunk);need(total<=65536,'H_LIFECYCLE_SERVICE_OUTPUT_BOUND')
                        outputs[key.fileobj].extend(chunk)
        child.wait(timeout=max(.001,end-time.monotonic()))
        return child.returncode,bytes(outputs[child.stdout]),bytes(outputs[child.stderr])
    finally:
        if child.poll() is None:
            os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
        child.stdout.close();child.stderr.close()


def _group_binding(pid):
    process=read_proc(pid);lines=_read(PROC/str(pid)/'cgroup',4096).splitlines()
    need(len(lines)==1 and lines[0].startswith('0::/'),'H_LIFECYCLE_HOST_CGROUP_REQUIRED')
    relative=Path(lines[0][3:]);need(relative.is_absolute() and '..' not in relative.parts,
                                  'H_LIFECYCLE_HOST_CGROUP_REQUIRED')
    root=CGROUP/str(relative).lstrip('/');info=root.lstat();parent=root.parent.lstat()
    need(stat.S_ISDIR(info.st_mode) and stat.S_ISDIR(parent.st_mode),'H_LIFECYCLE_HOST_CGROUP_REQUIRED')
    ancestors={};current=root.parent
    for count in range(65):
        need(count<64 and (current==CGROUP or current.is_relative_to(CGROUP)),'H_LIFECYCLE_CGROUP_BOUND')
        selected=current.lstat();need(stat.S_ISDIR(selected.st_mode),'H_LIFECYCLE_HOST_CGROUP_REQUIRED')
        ancestors[str(current.relative_to(CGROUP))]=[str(selected.st_dev),str(selected.st_ino)]
        if current==CGROUP:break
        current=current.parent
    need(read_proc(pid)==process,'H_LIFECYCLE_PROCESS_CHANGED')
    return {'path':str(relative),'identity':[str(info.st_dev),str(info.st_ino)],
            'parentIdentity':[str(parent.st_dev),str(parent.st_ino)],'ancestors':ancestors}


def _group_empty(binding):
    exact(binding,('path','identity','parentIdentity','ancestors'))
    relative=Path(binding['path']);need(relative.is_absolute() and '..' not in relative.parts,
                                       'H_LIFECYCLE_CGROUP_UNKNOWN')
    path=CGROUP/str(relative).lstrip('/');ancestor=path.parent
    for count in range(65):
        need(count<64 and (ancestor==CGROUP or ancestor.is_relative_to(CGROUP)), 'H_LIFECYCLE_CGROUP_BOUND')
        if os.path.lexists(ancestor):
            current=ancestor.lstat()
            need(stat.S_ISDIR(current.st_mode) and
                 [str(current.st_dev),str(current.st_ino)]==binding['ancestors'].get(str(ancestor.relative_to(CGROUP))),
                 'H_LIFECYCLE_CGROUP_CHANGED')
            break
        ancestor=ancestor.parent
    if not os.path.lexists(path):return
    info=path.lstat();need(stat.S_ISDIR(info.st_mode) and [str(info.st_dev),str(info.st_ino)]==binding['identity'],
                          'H_LIFECYCLE_CGROUP_CHANGED')
    values={}
    for line in _read(path/'cgroup.events',4096).splitlines():
        pair=line.split();need(len(pair)==2 and pair[0] not in values and pair[1].isdecimal(),
                              'H_LIFECYCLE_CGROUP_UNKNOWN');values[pair[0]]=pair[1]
    need(values.get('populated')=='0','H_LIFECYCLE_CGROUP_POPULATED')
    current=path.lstat();need((current.st_dev,current.st_ino)==(info.st_dev,info.st_ino),'H_LIFECYCLE_CGROUP_CHANGED')


def _pid_gone(process):
    need(type(process) is dict and type(process.get('pid')) is int and process['pid']>1 and
         type(process.get('start')) is int and process['start']>0,'H_LIFECYCLE_PROCESS_FACTS_REQUIRED')
    try:current=read_proc(process['pid'])
    except FileNotFoundError:return True
    return current['start']!=process['start']


def _listener(process,path):
    before=path.lstat()
    need(stat.S_ISSOCK(before.st_mode) and before.st_uid==os.getuid() and stat.S_IMODE(before.st_mode)==0o600,
         'H_LIFECYCLE_PRIVATE_LISTENER_REQUIRED')
    lines=_read(PROC/str(process['pid'])/'net/unix',1<<20).splitlines();matches=[]
    for line in lines[1:]:
        fields=line.split()
        if len(fields)==8 and fields[7]==str(path):
            need(fields[3]=='00010000' and fields[4]=='0001' and fields[5]=='01' and fields[6].isdecimal(),
                 'H_LIFECYCLE_NOT_LISTENING');matches.append(fields[6])
    need(len(matches)==1,'H_LIFECYCLE_UNIQUE_LISTENER_REQUIRED')
    holders=[]
    with os.scandir(PROC/str(process['pid'])/'fd') as descriptors:
        for count,entry in enumerate(descriptors,1):
            need(count<=1024,'H_LIFECYCLE_FD_BOUND')
            if not entry.name.isdecimal():continue
            try:target=os.readlink(entry.path)
            except FileNotFoundError:continue
            if target=='socket:['+matches[0]+']':holders.append(entry.name)
    need(len(holders)==1 and read_proc(process['pid'])==process,'H_LIFECYCLE_LISTENER_OWNER_CHANGED')
    after=path.lstat();need((after.st_dev,after.st_ino,after.st_mode,after.st_uid)==
                           (before.st_dev,before.st_ino,before.st_mode,before.st_uid),
                           'H_LIFECYCLE_LISTENER_CHANGED')
    return {'processDigest':digest(process),'socketDevice':str(before.st_dev),'socketInode':str(before.st_ino),
            'kernelSocketInode':matches[0]}


def _unit_directory():
    """Same ordinary-owner anchored provisioning as the existing H installer."""
    current=open_directory(Path.home())
    try:
        for name in ('.config','systemd','user'):
            try:os.mkdir(name,0o700,dir_fd=current);os.fsync(current)
            except FileExistsError:pass
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=current)
            try:
                info=os.fstat(child)
                need(info.st_uid==os.getuid() and not info.st_mode&0o022,'H_LIFECYCLE_UNIT_DIRECTORY')
            except BaseException:os.close(child);raise
            os.close(current);current=child
        return current
    except BaseException:os.close(current);raise


def select_and_exec(path,expected):
    """Fixed optional unit entry, before the existing --policy host program.

    Resolving a current generation does not resume it. A consumed START refuses
    even when systemd was manually restarted. The same PID execs immutable code.
    """
    need(type(expected) is str and SHA.fullmatch(expected),'H_LIFECYCLE_INITIAL_DIGEST_REQUIRED')
    value,signature=private_document(path,expected);exact(value,InitialInstallation.FIELDS)
    current_path=physical(value['controlBase'])/CONTROL_CURRENT
    selected,_current_signature=private_document(current_path)
    runtime=RuntimeManifest(selected['runtimeManifest'])
    initial=InitialInstallation(path,runtime)
    need(initial.enabled(),'H_LIFECYCLE_OWNER_MODE_CHANGED')
    record,policy,identities=initial.current()
    need(record==selected and not os.path.lexists(Path(policy['controlRoot'])/'START-ATTEMPT.json'),
         'H_LIFECYCLE_CONSUMED_GENERATION')
    need(private_document(path,expected)==(value,signature),'H_LIFECYCLE_INSTALLATION_CHANGED')
    args=runtime.host_program['argvPrefix']+['--policy',record['policyPath']]
    # Every reader/FD is closed. No shell, env-selected module, caller command
    # or old capability crosses this exec boundary.
    os.execv(args[0],args)


def main(argv=None,*,runtime_manifest):
    """Only the immutable Nix launcher supplies runtime_manifest, never argv."""
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installation',required=True)
    parser.add_argument('--lock-fd',type=int)
    parser.add_argument('phase',choices=('describe','settle','preflight-created','prepare-created','start-listener','await-ready'))
    parser.add_argument('--container-id');parser.add_argument('--spec');parser.add_argument('--spec-sha')
    args=parser.parse_args(argv)
    if args.phase not in ('preflight-created','prepare-created') and any(v is not None for v in (args.container_id,args.spec,args.spec_sha)):
        parser.error('Only preflight-created/prepare-created accept exact stopped-CID/spec data')
    if args.phase in ('preflight-created','prepare-created') and not all((args.container_id,args.spec,args.spec_sha)):
        parser.error('preflight-created/prepare-created require container-id/spec/spec-sha')
    if args.phase!='describe' and args.lock_fd is None:parser.error('An inherited held maintenance lock is required')
    os.umask(0o077)
    runtime=RuntimeManifest(runtime_manifest);initial=InitialInstallation(args.installation,runtime)
    if args.phase=='describe':result=initial.describe(args.lock_fd)
    elif args.phase=='settle':result=initial.settle(args.lock_fd)
    elif args.phase=='preflight-created':result=initial.preflight_created(args.lock_fd,args.container_id,args.spec,args.spec_sha)
    elif args.phase=='prepare-created':result=initial.prepare_created(args.lock_fd,args.container_id,args.spec,args.spec_sha)
    elif args.phase=='start-listener':result=initial.start_listener(args.lock_fd)
    else:result=initial.await_ready(args.lock_fd)
    print(json.dumps(result,sort_keys=True,separators=(',',':')))
    return 0


def _data_bytes(path,maximum,*,private=False):
    """Bound canonical company/spec data without the policy's smaller limit."""
    path=Path(path);parent=open_directory(path.parent);fd=None
    try:
        fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid() and before.st_nlink==1 and
             not before.st_mode&0o022 and (not private or stat.S_IMODE(before.st_mode)==0o600) and
             0<before.st_size<=maximum,'H_LIFECYCLE_DATA_CUSTODY')
        raw=bytearray()
        while chunk:=os.read(fd,min(65536,maximum+1-len(raw))):
            raw.extend(chunk);need(len(raw)<=maximum,'H_LIFECYCLE_DATA_BOUND')
        need(len(raw)==before.st_size and _native_stamp(os.fstat(fd))==_native_stamp(before) and
             _native_stamp(path.lstat())==_native_stamp(before),'H_LIFECYCLE_DATA_CHANGED')
        return bytes(raw),_native_stamp(before)
    finally:
        if fd is not None:os.close(fd)
        os.close(parent)


def _directory_identity(path):
    info=path.lstat();need(stat.S_ISDIR(info.st_mode),'H_LIFECYCLE_ANCESTRY_CHANGED')
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)


def _terminal_files(entries,*,data_paths=None,root_identities=None):
    """All readers/finalizers before the final stat-only cross-file bracket."""
    before={path:_stamp(path) for path in entries};parents={p for path in entries for p in path.parents}
    directory=_directory_identity
    ancestry={p:directory(p) for p in parents}
    for path,expected in (root_identities or {}).items():
        need(directory(path)==expected,'H_LIFECYCLE_ROOT_CHANGED')
        ancestry[path]=expected
    data_paths=data_paths or {}
    for path,value in entries.items():
        maximum,private=data_paths.get(path,(None,None))
        actual=private_bytes(path) if maximum is None else _data_bytes(path,maximum,private=private)
        need(actual==value,'H_LIFECYCLE_PUBLICATION_CHANGED')
    for path,signature in before.items():need(_stamp(path)==signature,'H_LIFECYCLE_PUBLICATION_CHANGED')
    for path,signature in ancestry.items():need(directory(path)==signature,'H_LIFECYCLE_ANCESTRY_CHANGED')
