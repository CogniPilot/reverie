"""Owned tiny stores, real native flocks, and an injected engine; no live engine."""
from copy import deepcopy
import fcntl
import json
import os
import socket
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reverie import worker_store_maintenance as M
from reverie.worker_storage import (storage_paths, storage_guard, prepare_storage,
                                    record_storage_binding, lock_paths)

EMP = '11111111-2222-4333-8444-555555555555'
SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
OP = '99999999-8888-4777-8666-555555555555'
NEW = 'sha256:' + '1'*64
OLD = 'sha256:' + '2'*64
BASE = '/nix/store/' + 'a'*32 + '-fixture-base'
PRIOR = '/nix/store/' + 'b'*32 + '-old-base'
VALIDATION = 'a'*64
STOPPED = 'b'*64
HELPER = 'c'*64


class Engine:
    def __init__(self, fixture):
        self.f = fixture
        self.calls = []
        self.rows = {
            VALIDATION: {'Id': VALIDATION, 'Image': NEW, 'Name': '/validation',
                         'State': {'Running': True, 'Pid': 10}, 'Mounts': []},
            STOPPED: {'Id': STOPPED, 'Image': OLD, 'Name': '/old-laptop',
                      'State': {'Running': False, 'Pid': 0}, 'Mounts': [
                          {'Type':'bind', 'Source':str(fixture.paths.home), 'Destination':'/home/agent','RW':True},
                          {'Type':'bind', 'Source':str(fixture.paths.nix), 'Destination':'/nix','RW':True}]}}
        self.fail = None
        self.after_start = None
        self.bad_host = None

    def identity(self): return 'fixture-engine'
    def image(self, image):
        return {'Id':image, 'Config':{'User':f'{os.getuid()}:{os.getgid()}',
                                    'Labels':{'reverie.worker.nix-store':'1'}}}
    def containers(self): return deepcopy(list(self.rows.values()))
    def inspect(self, cid): return deepcopy(self.rows[cid])
    def base_target(self, cid): return BASE
    def create(self, args):
        self.calls.append(('create', args))
        # Independent file descriptions prove BOTH existing broker lock inodes.
        for path in (self.f.lock, self.f.sid_lock):
            fd = os.open(path, os.O_RDWR)
            try:
                with self.f.assertRaises(BlockingIOError):
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally: os.close(fd)
        self.f.assertTrue(self.f.fence.exists())
        if self.fail == 'create': raise TimeoutError('unknown create')
        host = {'ReadonlyRootfs':True, 'NetworkMode':'none', 'Privileged':False,
                'CapDrop':['ALL'], 'CapAdd':None, 'Memory':512*1024**2,
                'MemorySwap':512*1024**2, 'PidsLimit':128, 'NanoCpus':1000000000,
                'RestartPolicy':{'Name':'no'}, 'SecurityOpt':['no-new-privileges:true'],
                'Tmpfs':{'/tmp':'rw,nosuid,nodev,size=268435456,mode=1777',
                         '/nix/store/.links':'rw,nosuid,nodev,size=1048576,mode=1777'}}
        if self.bad_host: host.update(self.bad_host)
        self.rows[HELPER] = {'Id':HELPER, 'Image':NEW,
            'Name':'/'+self.f.config['deployment']+'-nix-prepare-'+SID,
            'Config':{'User':f'{os.getuid()}:{os.getgid()}',
                      'Entrypoint':['/bin/reverie-nix-store-prepare'],
                      'Labels':{'reverie.nix-prepare':'fixture','reverie.session':SID,
                                'reverie.offline-store-operation':OP}},
            'HostConfig':host, 'State':{'Running':False,'Pid':0,'ExitCode':0,'Status':'created'},
            'Mounts':[{'Type':'bind','Source':str(self.f.paths.nix), 'Destination':'/target/nix','RW':True}]}
        return HELPER
    def start(self, cid):
        self.calls.append(('start',cid))
        if self.fail == 'start': raise TimeoutError('unknown start')
        root = self.f.paths.nix
        (root/'store'/Path(BASE).name).mkdir()
        link = root/'var/nix/gcroots/reverie-image'
        link.unlink(); link.symlink_to(BASE)
        self.rows[cid]['State'] = {'Running':False,'Pid':0,'ExitCode':1 if self.fail == 'exit' else 0,
                                   'Status':'exited','StartedAt':'2026-01-01T00:00:00Z'}
        if self.after_start: self.after_start()
    def remove(self,cid):
        self.calls.append(('rm',cid))
        if self.fail == 'remove': raise TimeoutError('unknown remove')
        del self.rows[cid]


class OfflineStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='offline-store-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.state = self.root/'state'; self.state.mkdir(mode=0o700)
        self.scratch = self.root/'scratch'; self.scratch.mkdir(mode=0o700)
        self.public = self.root/'public'; self.public.mkdir()
        self.office = self.root/'office'; self.office.mkdir(mode=0o700)
        self.company_path = self.root/'company.json'
        self.employee = {'id':EMP,'sessionId':SID,'sessionGeneration':1,'owner':'owner-a',
                         'desiredRunning':False,'onVacation':True,
                         'runtimeRecipe':{'mode':'codex','subscriptionProfile':{'id':'fixture-account'}}}
        self.company = {'employees':[self.employee],'retired':[]}
        self.write(self.company_path,self.company)
        self.config = {'version':1,'deployment':'fixture','image':NEW,'serverContainer':'fixture-web',
            'socket':'/run/fixture.sock','stateRoot':str(self.state),'companyFile':str(self.company_path),
            'companyRoot':str(self.office),'scratchRoot':str(self.scratch),'apiSocketRoot':str(self.root/'api'),
            'budgetMode':'admission','uid':os.getuid(),'gid':os.getgid(),'memoryMiB':512,
            'poolMemoryMiB':1024,'poolTasksMax':256,'cgroupParent':'reverie-workers.slice',
            'pidsLimit':128,'cpus':1,'maxWorkers':4,'mounts':[{'source':str(self.public),
               'destination':'/workspace','readOnly':False}],'maintenanceSessions':[]}
        self.config_path = self.root/'broker.json'; self.write(self.config_path,self.config)
        self.paths = storage_paths(self.config,SID)
        with storage_guard(self.config,SID):
            prepare_storage(self.config,self.paths); record_storage_binding(self.config,self.paths)
        self.lock,self.fence = lock_paths(self.config,self.paths)
        self.sid_lock = self.state/SID/'nix.lock'; self.sid_lock.touch(mode=0o600)
        (self.paths.nix/'store').mkdir()
        (self.paths.nix/'var/nix/profiles').mkdir(parents=True)
        (self.paths.nix/'var/nix/gcroots').mkdir()
        (self.paths.nix/'var/nix/gcroots/reverie-image').symlink_to(PRIOR)
        (self.paths.home/'keep').write_text('owner data')
        self.receipts = {}
        for kind in ('D2','CAN'):
            path = self.root/(kind+'.json'); raw = self.root/(kind+'.txt')
            text = ('PASS shim body = F1 r7 / native bridge r5 (shebang line excluded)\n'
                    'PASS builder body = r5 (fixture)\nPASS cargo resolves to the shim\n'
                    'PASS shim sets CARGO_BUILD_JOBS=2\nPASS REVERIE_NO_AUTOENV=1 untouched\n'
                    'PASS explicit -j left as given\njobs=2\n') if kind=='D2' else 'GREP pos=0 neg=1 find=0\nSHIMS /opt/reverie/autoenv/bin/cargo /shim jobs=2\nCAN-DONE\n'
            self.bytes(raw,text.encode())
            data = {'version':1,'employeeId':EMP,'containerId':VALIDATION,'rawEvidencePath':str(raw),'rawEvidenceDigest':M.sha(raw.read_bytes())}
            if kind == 'D2':data['jobs']=2
            if kind == 'CAN':
                probe=self.root/'probe'; self.bytes(probe,b'actual fixture own-shell probe')
                data.update(ownToolShell=True,scope='CURRENT_CODEX_TOOL_SHELL_ONLY',probePath=str(probe),probeDigest=M.sha(probe.read_bytes()))
            self.write(path,{'version':1,'kind':kind,'data':data})
            self.receipts[kind]={'path':str(path),'digest':M.sha(path.read_bytes())}
        self.target = {'version':1,'kind':'reverie.worker-store-target','imageId':NEW,
            'engineId':'fixture-engine','engineSocket':'/run/docker.sock','validationContainerId':VALIDATION,
            'baseTarget':BASE,'closurePaths':[BASE],'expiresAtEpoch':2000000000,
            'cohort':[{'employeeId':EMP,'sessionId':SID,'sessionGeneration':1,'employeeDigest':M.sha(M.canonical(self.employee))}],
            'budget':{'fullClosureAllocatedBytes':1000,'overheadBytes':1000,'mainFloorBytes':1000,'scratchFloorBytes':1000},
            'receipts':self.receipts}
        self.target_path=self.root/'target.json'; self.write(self.target_path,self.target)
        self.engine=Engine(self)
        self.maintenance=M.OfflineStoreMaintenance(self.config_path,self.target_path,engine=self.engine,
            statvfs=lambda _:SimpleNamespace(f_bavail=10**12,f_frsize=1),wall=lambda:1800000000)
    def bytes(self,path,raw): path.write_bytes(raw); path.chmod(0o600)
    def write(self,path,value): self.bytes(path,M.canonical(value))
    def plan(self): return self.maintenance.plan(EMP,OP)
    def apply(self):
        plan=self.plan()
        return self.maintenance.apply(EMP,OP,plan['planDigest'])
    def offline_image_scope(self):
        self.target['validationScope']=M.OFFLINE_IMAGE_SCOPE
        for reference in self.target['receipts'].values():
            path=Path(reference['path']);record=json.loads(path.read_bytes());data=record['data']
            data.pop('employeeId');data.pop('ownToolShell',None)
            data.update(imageId=NEW,scope=M.OFFLINE_EVIDENCE_SCOPE)
            self.write(path,record);reference['digest']=M.sha(path.read_bytes())
        self.engine.rows[VALIDATION].update(Config={'User':f'{os.getuid()}:{os.getgid()}'},
            HostConfig={'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,
                'CapAdd':None,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],
                'Memory':4*M.GIB,'MemorySwap':4*M.GIB,'PidsLimit':256,'NanoCpus':2000000000})
        self.write(self.target_path,self.target)
    def test_offline_image_scope_prepares_store_without_claiming_runtime_acceptance(self):
        self.offline_image_scope();before=self.company_path.read_bytes()
        result=self.apply()
        self.assertEqual(result['state'],'STORE_PREPARED_RUNTIME_ACCEPTANCE_PENDING')
        self.assertEqual(result['validationScope'],M.OFFLINE_IMAGE_SCOPE)
        self.assertEqual(result['runtimeAcceptance'],'PENDING')
        self.assertEqual(result['containerAdoption'],'NOT_RUN');self.assertFalse(result['providerLaunched'])
        self.assertEqual(self.company_path.read_bytes(),before)
        for reference in self.target['receipts'].values():
            data=json.loads(Path(reference['path']).read_bytes())['data']
            self.assertNotIn('employeeId',data);self.assertNotIn('ownToolShell',data)
    def test_offline_image_scope_keeps_strict_vacation_admission(self):
        self.offline_image_scope();self.employee['onVacation']=False
        self.target['cohort'][0]['employeeDigest']=M.sha(M.canonical(self.employee))
        self.write(self.company_path,self.company);self.write(self.target_path,self.target)
        with self.assertRaises(M.Refused):self.plan()
        self.assertEqual(self.engine.calls,[])
    def test_offline_proof_cannot_be_relabelled_current_agent_proof(self):
        self.offline_image_scope();del self.target['validationScope'];self.write(self.target_path,self.target)
        with self.assertRaisesRegex(M.Refused,'closed canonical'):self.plan()
        self.assertEqual(self.engine.calls,[])
    def test_offline_image_scope_binds_exact_image_and_sandbox(self):
        self.offline_image_scope();path=self.root/'D2.json';record=json.loads(path.read_bytes())
        record['data']['imageId']=OLD;self.write(path,record)
        self.target['receipts']['D2']['digest']=M.sha(path.read_bytes());self.write(self.target_path,self.target)
        with self.assertRaisesRegex(M.Refused,'exact image/scope'):self.plan()
        record['data']['imageId']=NEW;self.write(path,record)
        self.target['receipts']['D2']['digest']=M.sha(path.read_bytes());self.write(self.target_path,self.target)
        for field,value in [('NetworkMode','bridge'),('PidMode','host'),('IpcMode','host'),
                            ('UsernsMode','host'),('VolumesFrom',['other'])]:
            with self.subTest(field=field):
                host=self.engine.rows[VALIDATION]['HostConfig'];previous=deepcopy(host)
                host[field]=value
                with self.assertRaisesRegex(M.Refused,'sandbox differs'):self.plan()
                host.clear();host.update(previous)
        self.assertEqual(self.engine.calls,[])
    def test_offline_image_scope_refuses_private_and_socket_mounts(self):
        self.offline_image_scope();sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.addCleanup(sock.close);sock.bind(str(self.root/'engine.sock'))
        cases=[(self.paths.nix,'/output',True,'private employee/account'),
               (self.public,'/home/agent',False,'private runtime'),
               (self.root/'engine.sock','/engine.sock',False,'sockets or devices')]
        for source,destination,rw,error in cases:
            with self.subTest(source=source):
                self.engine.rows[VALIDATION]['Mounts']=[{'Type':'bind','Source':str(source),
                    'Destination':destination,'RW':rw}]
                with self.assertRaisesRegex(M.Refused,error):self.plan()
        self.assertEqual(self.engine.calls,[])
    def test_offline_image_scope_refuses_parent_of_office_socket(self):
        self.offline_image_scope();root=Path(self.config['apiSocketRoot']);root.mkdir(mode=0o700)
        sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.addCleanup(sock.close)
        sock.bind(str(root/'office.sock'))
        self.engine.rows[VALIDATION]['Mounts']=[{'Type':'bind','Source':str(root),
            'Destination':'/office-parent','RW':False}]
        with self.assertRaisesRegex(M.Refused,'private employee/account'):self.plan()
        self.assertEqual(self.engine.calls,[])
    def test_plan_is_readonly(self):
        before=set(self.state.rglob('*')); plan=self.plan()
        self.assertEqual(plan['imageId'],NEW); self.assertEqual(self.engine.calls,[])
        self.assertEqual(before,set(self.state.rglob('*')))
    def test_success_uses_both_real_locks_and_preserves_off_data_and_old_container(self):
        before=self.company_path.read_bytes(); config=self.config_path.read_bytes()
        result=self.apply()
        self.assertEqual(result['state'],'STORE_PREPARED'); self.assertFalse(result['providerLaunched'])
        self.assertEqual(result['containerAdoption'],'NOT_RUN')
        self.assertEqual(self.company_path.read_bytes(),before); self.assertEqual(self.config_path.read_bytes(),config)
        self.assertEqual((self.paths.home/'keep').read_text(),'owner data')
        self.assertIn(STOPPED,self.engine.rows); self.assertNotIn(HELPER,self.engine.rows)
        self.assertFalse(self.fence.exists())
        args=self.engine.calls[0][1]
        self.assertNotIn(str(self.paths.home),str(args)); self.assertIn('--network',args)
        self.assertEqual(self.engine.calls[-1],('rm',HELPER))
        with storage_guard(self.config,SID): pass
    def test_native_lock_conflict_refuses_before_fence_or_engine(self):
        for path in (self.lock,self.sid_lock):
            with self.subTest(path=path):
                fd=os.open(path,os.O_RDWR); fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                try:
                    with self.assertRaises(BlockingIOError): self.apply()
                finally: os.close(fd)
                self.assertFalse(self.fence.exists()); self.assertEqual(self.engine.calls,[])
    def test_unknown_engine_operation_retains_durable_broker_fence(self):
        for failure in ('create','start','exit','remove'):
            with self.subTest(failure=failure):
                self.engine.fail=failure
                with self.assertRaises(M.Unconfirmed): self.apply()
                self.assertTrue(self.fence.exists())
                with self.assertRaisesRegex(RuntimeError,'fenced'):
                    with storage_guard(self.config,SID): pass
                with self.assertRaises(M.Refused): self.plan()
                self.fence.unlink()
                for p in (self.state/'offline-store-maintenance').iterdir(): p.unlink()
                self.engine.rows.pop(HELPER,None)
                for p in (self.paths.nix/'store').iterdir(): p.rmdir()
                link=self.paths.nix/'var/nix/gcroots/reverie-image';link.unlink();link.symlink_to(PRIOR)
    def test_current_off_vacation_sid_account_and_generation_are_exact(self):
        for field,value in (('desiredRunning',True),('onVacation',False),('sessionId',OP),('sessionGeneration',2),('runtimeRecipe',{'mode':'other'})):
            old=deepcopy(self.employee)
            with self.subTest(field=field):
                self.employee[field]=value;self.write(self.company_path,self.company)
                with self.assertRaises(M.Refused): self.plan()
                self.assertEqual(self.engine.calls,[])
                self.employee.clear();self.employee.update(old);self.write(self.company_path,self.company)
    def test_target_must_be_selected_and_qualified(self):
        self.config['image']=OLD; self.write(self.config_path,self.config)
        with self.assertRaisesRegex(M.Refused,'already be selected'): self.plan()
    def test_failed_d2_or_tampered_probe_cannot_qualify_target(self):
        raw=self.root/'D2.txt';self.bytes(raw,b'FAIL cargo\n')
        with self.assertRaises(M.Refused): self.plan()
        self.assertEqual(self.engine.calls,[])
    def test_tampered_actual_can_probe_refuses(self):
        self.bytes(self.root/'probe',b'changed probe')
        with self.assertRaisesRegex(M.Refused,'probe bytes changed'):self.plan()
    def qualification_text(self,kind,text):
        raw=self.root/(kind+'.txt');self.bytes(raw,text.encode())
        path=self.root/(kind+'.json');record=json.loads(path.read_bytes())
        record['data']['rawEvidenceDigest']=M.sha(raw.read_bytes());self.write(path,record)
        self.target['receipts'][kind]['digest']=M.sha(path.read_bytes());self.write(self.target_path,self.target)
    def test_d2_arbitrary_six_passes_or_reordered_assertions_cannot_qualify(self):
        original=(self.root/'D2.txt').read_text()
        for text in ('PASS cargo resolves to the shim\n'+''.join('PASS check'+str(i)+'\n' for i in range(5))+'jobs=2\n',
                     original.replace('PASS builder body = r5 (fixture)','PASS explicit -j left as given')):
            with self.subTest(text=text):
                self.qualification_text('D2',text)
                with self.assertRaisesRegex(M.Refused,'D2 did not pass'):self.plan()
        self.assertEqual(self.engine.calls,[])
    def test_can_uses_exact_first_token_and_grep_groups(self):
        original=(self.root/'CAN.txt').read_text()
        for text in (original.replace('find=0','find=01'),
                     original.replace('jobs=2','jobs=ERROR\nlater jobs=2'),
                     original.replace('/opt/reverie/autoenv/bin/cargo','/bin/cargo')):
            with self.subTest(text=text):
                self.qualification_text('CAN',text)
                with self.assertRaisesRegex(M.Refused,'CAN did not pass'):self.plan()
        self.assertEqual(self.engine.calls,[])
    def test_profile_parent_alias_refuses_without_following_it(self):
        local=self.paths.home/'.local';local.symlink_to(self.public)
        with self.assertRaises(OSError):self.plan()
    def test_created_zero_exit_metadata_is_not_completion(self):
        def never_started():self.engine.rows[HELPER]['State']['Status']='created'
        self.engine.after_start=never_started
        with self.assertRaises(M.Unconfirmed):self.apply()
        self.assertTrue(self.fence.exists())
    def test_foreign_writer_even_without_labels_refuses(self):
        self.engine.rows[STOPPED]['State']={'Running':True,'Pid':2}
        with self.assertRaisesRegex(M.Refused,'another running'):self.plan()
    def test_physical_alias_of_control_or_nix_is_not_lexically_trusted(self):
        alias=self.root/'bind-alias';alias.mkdir()
        actual=M._inode
        for protected in (self.paths.nix, self.lock.parent):
            self.engine.rows['d'*64]={'Id':'d'*64,'State':{'Running':True,'Pid':9},
                'Mounts':[{'Type':'bind','Source':str(alias),'RW':True}]}
            def identity(path):return actual(protected) if Path(path)==alias else actual(path)
            with self.subTest(protected=protected),patch.object(M,'_inode',identity):
                with self.assertRaises(M.Refused):self.plan()
        self.assertEqual(self.engine.calls,[])
    def test_nested_host_mount_alias_under_public_bind_is_checked(self):
        alias=self.public/'nested';alias.mkdir();actual=M._inode
        def identity(path):return actual(self.root) if Path(path)==alias else actual(path)
        with patch.object(M,'_mount_points',return_value=[alias]),patch.object(M,'_inode',identity):
            with self.assertRaisesRegex(M.Refused,'control is exposed'):self.plan()
        self.assertEqual(self.engine.calls,[])
    def test_control_exposure_through_configured_future_mount_refuses(self):
        alias=self.public/'evidence'; self.target_path.rename(alias);self.target_path=alias
        self.maintenance.target_path=alias
        with self.assertRaisesRegex(M.Refused,'control is exposed'):self.plan()
    def test_future_account_and_cold_employee_namespaces_cannot_hold_control(self):
        for directory in (self.office, self.state/'employees'/'unstarted-fixture'):
            directory.mkdir(mode=0o700,exist_ok=True)
            alias=directory/'evidence';self.bytes(alias,self.target_path.read_bytes())
            self.maintenance.target_path=alias
            with self.subTest(directory=directory),self.assertRaisesRegex(M.Refused,'control is exposed'):self.plan()
        self.assertEqual(self.engine.calls,[])
    def test_helper_collision_is_not_removed_by_name(self):
        self.engine.rows[STOPPED]['Name']='/fixture-nix-prepare-'+SID
        with self.assertRaisesRegex(M.Refused,'existing helper'):self.plan()
        self.assertEqual(self.engine.calls,[])
    def test_helper_unexpected_host_privilege_fails_fenced(self):
        self.engine.bad_host={'Privileged':True}
        with self.assertRaises(M.Unconfirmed):self.apply()
        self.assertTrue(self.fence.exists());self.assertEqual(len(self.engine.calls),1)
    def test_midseed_intent_drift_fails_fenced(self):
        def change():
            self.employee['desiredRunning']=True;self.write(self.company_path,self.company)
        self.engine.after_start=change
        with self.assertRaises(M.Unconfirmed):self.apply()
        self.assertTrue(self.fence.exists());self.assertNotIn(('rm',HELPER),self.engine.calls)
    def test_unrelated_profile_change_fails_fenced(self):
        self.engine.after_start=lambda:(self.paths.nix/'var/nix/profiles/unexpected').symlink_to(PRIOR)
        with self.assertRaises(M.Unconfirmed):self.apply()
        self.assertTrue(self.fence.exists())
    def test_plan_drift_refuses_without_mutation(self):
        plan=self.plan();self.config['cpus']=2;self.write(self.config_path,self.config)
        with self.assertRaises(M.Refused):self.maintenance.apply(EMP,OP,plan['planDigest'])
        self.assertEqual(self.engine.calls,[])
    def test_expiry_after_slow_locked_snapshot_prevents_create(self):
        plan=self.plan()
        real=self.maintenance._snapshot;count=0;now=1800000000
        self.maintenance.wall=lambda:now
        def slow(employee):
            nonlocal count,now
            result=real(employee);count+=1
            if count==3:now=2000000001
            return result
        with patch.object(self.maintenance,'_snapshot',slow):
            with self.assertRaises(M.Unconfirmed):self.maintenance.apply(EMP,OP,plan['planDigest'])
        self.assertEqual(self.engine.calls,[]);self.assertTrue(self.fence.exists())
    def test_expiry_during_created_helper_inspection_prevents_start(self):
        real=self.engine.inspect;now=1800000000;self.maintenance.wall=lambda:now
        def slow(cid):
            nonlocal now
            result=real(cid)
            if cid==HELPER:now=2000000001
            return result
        with patch.object(self.engine,'inspect',slow):
            with self.assertRaises(M.Unconfirmed):self.apply()
        self.assertEqual([call[0] for call in self.engine.calls],['create'])
        self.assertTrue(self.fence.exists())
    def test_capacity_has_no_gc_credit(self):
        self.maintenance.statvfs=lambda _:SimpleNamespace(f_bavail=1,f_frsize=1)
        with self.assertRaisesRegex(M.Refused,'capacity'):self.plan()
    def test_private_fifo_and_profile_symlink_parent_refuse_without_hang(self):
        self.target_path.unlink();os.mkfifo(self.target_path,0o600)
        with self.assertRaises(M.Refused):self.plan()
    def test_missing_native_lock_is_not_replaced(self):
        self.sid_lock.unlink()
        with self.assertRaises(FileNotFoundError):self.plan()
        self.assertFalse(self.sid_lock.exists());self.assertEqual(self.engine.calls,[])
    def test_lock_cleanup_unknown_is_not_reported_as_no_effect(self):
        real=M._existing_lock
        from contextlib import contextmanager
        @contextmanager
        def fail_exit(path,uid):
            with real(path,uid) as check: yield check
            if path==self.lock:raise OSError('close unknown')
        with patch.object(M,'_existing_lock',fail_exit):
            with self.assertRaises(M.Unconfirmed):self.apply()
        self.assertTrue(self.fence.exists())
    def test_success_operation_cannot_be_reused(self):
        self.apply()
        with self.assertRaisesRegex(M.Refused,'already recorded'):self.plan()
    def test_profile_inventory_bound_counts_absent_scopes(self):
        with patch.object(M,'MAX_ENTRIES',3):
            with self.assertRaises(M.Refused):M._profiles(self.paths)
    def test_private_json_duplicate_and_nonfinite_refuse(self):
        for raw in (b'{"a":1,"a":2}',b'{"a":NaN}'):
            with self.assertRaises(M.Refused):M._json(raw)
    def client(self, body):
        script=self.root/'fake-engine'
        script.write_text('#!'+sys.executable+'\n'+body+'\n');script.chmod(0o700)
        engine=M.DockerEngine.__new__(M.DockerEngine)
        engine.executable=str(script);engine.endpoint='unix:///unused-owned-fixture'
        return engine
    def test_native_cli_binary_output_is_preserved(self):
        engine=self.client('import os;os.write(1,b"\\0tar\\xff")')
        self.assertEqual(engine._run(['fixture']),b'\0tar\xff')
    def test_native_cli_output_and_timeout_are_bounded(self):
        engine=self.client('import os;os.write(2,b"x"*1000000)')
        with self.assertRaisesRegex(M.Refused,'response bound'):engine._run(['fixture'])
        engine=self.client('import time;time.sleep(1)')
        with self.assertRaisesRegex(M.Refused,'deadline'):engine._run(['fixture'],timeout=.03)

if __name__=='__main__':unittest.main()
