"""Owned synthetic authority fixtures and REAL same-kernel cross-process flock controls.

No host engine/service action or host/laptop/root qualification is performed.
The long rehearsal uses the production 60/5 timings and real subprocess locks;
its fixture owner is explicitly the ordinary test user, so it cannot yield a
production accepted root receipt.
"""
from contextlib import contextmanager
import copy
import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

from reverie.cleanup import acceptance as A, acceptance_io as I, peer_port as P

EMP='11111111-1111-4111-8111-111111111111'
SID='22222222-2222-4222-8222-222222222222'


class IOTests(unittest.TestCase):
    def test_duplicate_and_nonfinite_json_refuse(self):
        for raw in (b'{"a":1,"a":2}',b'{"x":NaN}',b'{"x":Infinity}'):
            with self.subTest(raw=raw),self.assertRaises(ValueError):I.decoded(raw)

    def test_nofollow_pins_ancestor_and_rejects_fifo_without_blocking(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name).resolve();(root/'a').mkdir();(root/'a/d').mkdir();(root/'other').mkdir()
            (root/'a/d/value').write_bytes(b'owned');fd=I.open_directory(root/'a/d')
            try:
                identity=I.inode(os.fstat(fd));(root/'a').rename(root/'saved');(root/'a').symlink_to(root/'other')
                self.assertEqual(I.inode(os.fstat(fd)),identity)
                with self.assertRaises(OSError):I.open_directory(root/'a/d')
                os.mkfifo(root/'saved/d/fifo');start=time.monotonic()
                with self.assertRaises(ValueError):I.regular(fd,'fifo')
                self.assertLess(time.monotonic()-start,1)
                value=I.regular(fd,'value')
                try:
                    with self.assertRaises(ValueError):I.snapshot(value,limit=1)
                finally:os.close(value)
            finally:os.close(fd)

    def test_framing_is_bounded_and_deadline_cannot_be_renewed(self):
        a,b=socket.socketpair()
        try:
            b.sendall((I.MAX_MESSAGE+1).to_bytes(4,'big'))
            with self.assertRaises(ValueError):I.receive_message(a,time.monotonic()+1)
        finally:a.close();b.close()

    def test_duplicate_flock_requires_explicit_unlock(self):
        with tempfile.TemporaryDirectory() as t:
            path=Path(t)/'lock';fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600)
            fcntl.flock(fd,fcntl.LOCK_EX);duplicate=os.dup(fd);os.close(fd)
            code='import fcntl,os,sys\nf=os.open(sys.argv[1],os.O_RDWR)\ntry:fcntl.flock(f,fcntl.LOCK_SH|fcntl.LOCK_NB)\nexcept BlockingIOError:sys.exit(3)'
            try:
                args=[sys.executable,'-I','-B','-c',code,str(path)]
                self.assertEqual(subprocess.run(args,timeout=5).returncode,3)
                fcntl.flock(duplicate,fcntl.LOCK_UN)
                self.assertEqual(subprocess.run(args,timeout=5).returncode,0)
            finally:os.close(duplicate)


class Fixture:
    def __init__(self, root):
        self.root=Path(root).resolve();self.home=self.root/'home';self.tmp=self.root/'tmp';self.home.mkdir();self.tmp.mkdir()
        self.leases=self.home/'.local/state/reverie/leases';self.leases.mkdir(parents=True,mode=0o700)
        self.state=self.root/'state';self.state.mkdir(mode=0o700)
        self.option={'socket':str(self.state/'peer/peer.sock'),'employeeId':EMP,'leaseSubdirectory':'.local/state/reverie/leases','peerBinary':'/nix/store/test-static/bin/peer'}
        self.broker=type('Broker',(),{'config':{'uid':os.getuid(),'stateRoot':str(self.state)}})()
        self.binding={'employeeId':EMP,'sessionId':SID,'sessionGeneration':1,'containerId':'a'*64,'imageId':'sha256:'+'b'*64,'initPid':os.getpid(),
                      'home':str(self.home),'tmp':str(self.tmp),'uid':os.getuid(),'gid':os.getgid(),'helperSha256':'c'*64,'leaseSubdirectory':self.option['leaseSubdirectory'],'workerConfigHash':'1'*64,'workerPolicyHash':'2'*64}
        self.changed=False;self.launched=0;self.children=[]

    def begin(self,deadline):self.deadline=deadline
    def custody(self):pass  # Synthetic authority fixture only; production uses actual inspected mounts.
    def resolve(self,employee):
        I.require(employee==EMP and not self.changed,'synthetic selected peer changed')
        return copy.deepcopy(self.binding)
    def launch(self,binding,expires):
        self.launched+=1
        if os.environ.get('REVERIE_TEST_STATIC_PEER'):
            child=subprocess.Popen([os.environ['REVERIE_TEST_STATIC_PEER'],str(self.home),str(self.tmp)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            self.children.append(child)
            return P.HelperProcess(child,expires)
        source=Path(P.__file__).with_name('peer_helper.py')
        code="from pathlib import Path\nimport importlib.util,sys\ns=importlib.util.spec_from_file_location('fixed_test_helper',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.run(Path(sys.argv[2]),Path(sys.argv[3]))"
        child=subprocess.Popen([sys.executable,'-I','-B','-u','-c',code,str(source),str(self.home),str(self.tmp)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        self.children.append(child)
        return P.HelperProcess(child,expires)

    def cleanup(self):
        for child in self.children:
            if child.poll() is None:
                child.stdin.close()
                try:child.wait(timeout=6)
                except subprocess.TimeoutExpired:child.kill();child.wait()
            child.stdout.close();child.stderr.close()


class PortTests(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup)
        self.backend=Fixture(self.t.name);self.addCleanup(self.backend.cleanup)
        self.server=P.PeerServer(self.backend);self.addCleanup(self.server.close)
        self.attempt=str(uuid.uuid4());self.nonce='d'*64
    def request(self,method='prepare',**extra):
        value={'version':1,'method':method,'attemptId':self.attempt,'nonce':self.nonce}
        if method=='prepare':value.update(employeeId=EMP,expiresAt=time.time()+180)
        value.update(extra);return value

    def test_real_unix_os_peer_rejects_ordinary_user(self):
        if os.getuid()==0:self.skipTest('denial case requires ordinary test user')
        self.server.start()
        client=P.PeerClient(self.backend.option['socket'],os.getuid())
        with self.assertRaises(ValueError):client.call(self.request())
        self.assertEqual(self.backend.launched,0)

    def test_closed_requests_do_not_launch_arbitrary_code_or_paths(self):
        for change in ({'method':'exec'},{'command':'sh'},{'source':'evil'},{'path':'/etc'},{'employeeId':SID},{'expiresAt':time.time()+900}):
            with self.subTest(change=change),self.assertRaises(ValueError):self.server.request(self.request(**change))
        self.assertEqual(self.backend.launched,0)

    def test_prepare_holds_real_locks_then_retires_only_owned_probe(self):
        prepared=self.server.request(self.request());probe=prepared['result']['probe']
        fd=os.open(self.backend.leases/(probe['heldKey']+'.lock'),os.O_RDWR)
        try:
            with self.assertRaises(BlockingIOError):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally:os.close(fd)
        result=self.server.request(self.request('retireOwn'))
        self.assertTrue(result['result']['cleanupComplete'])
        self.assertEqual(list(self.backend.tmp.iterdir()),[])
        self.assertTrue((self.backend.leases/(probe['heldKey']+'.lock')).exists(),'normal lease locks must remain for lease GC')
        self.assertIsNone(self.server.job)

    def test_peer_change_prevents_control_and_closes_owned_job(self):
        self.server.request(self.request());self.backend.changed=True
        with self.assertRaises(ValueError):self.server.request(self.request('during'))
        self.assertIsNone(self.server.job)

    def test_retire_does_not_require_changed_employee_to_be_running(self):
        self.server.request(self.request());self.backend.changed=True
        self.assertTrue(self.server.request(self.request('retireOwn'))['result']['cleanupComplete'])

    def test_second_prepare_and_wrong_nonce_refuse(self):
        self.server.request(self.request())
        with self.assertRaises(ValueError):self.server.request(self.request())
        with self.assertRaises(ValueError):self.server.request(self.request('after',nonce='e'*64))
        self.server.request(self.request('retireOwn'))

    def test_real_sixty_second_kernel_rehearsal_is_not_root_acceptance(self):
        prepared=self.server.request(self.request())
        class DirectPort:
            def call(_,request):return self.server.request(request)
        deployment={'lease_subdir':self.backend.option['leaseSubdirectory']}
        source=Path(A.__file__).with_name('lease.py').read_bytes()
        start=time.monotonic()
        proof=A.kernel_gate({},prepared,DirectPort(),deployment,source,fixture_owner=os.getuid())
        self.assertGreaterEqual(time.monotonic()-start,60)
        self.assertGreaterEqual(proof['hostHoldSeconds'],60)
        self.assertEqual(proof['during']['status'],'REFUSED');self.assertGreaterEqual(proof['during']['durationSeconds'],5)
        self.assertEqual(proof['after']['status'],'ACQUIRED')
        self.assertNotEqual(proof['rootBeforeUid'],0,'owned rehearsal must not impersonate root qualification')
        self.server.request(self.request('retireOwn'))


class SchemaTests(unittest.TestCase):
    def test_default_disabled_and_closed_broker_configuration(self):
        base={'uid':1000,'socket':'/host/state/broker.sock','stateRoot':'/host/state'}
        self.assertIsNone(P.validate_option(base))
        good=dict(base,leaseAcceptance={'socket':'/host/state/lease-peer/peer.sock','employeeId':EMP,'leaseSubdirectory':'.local/state/reverie/leases','peerBinary':'/nix/store/test-static/bin/peer'})
        self.assertEqual(P.validate_option(good)['employeeId'],EMP)
        for option in (dict(good['leaseAcceptance'],command='x'),dict(good['leaseAcceptance'],socket='/host/state/employees/x/p.sock'),dict(good['leaseAcceptance'],employeeId='Stan'),dict(good['leaseAcceptance'],leaseSubdirectory='../escape')):
            with self.subTest(option=option),self.assertRaises(ValueError):P.validate_option(dict(base,leaseAcceptance=option))

    def test_control_never_confuses_direct_result_with_process_exit(self):
        probe={'barrierKey':'1-2'};root='3-4';attempt=str(uuid.uuid4());nonce='f'*64
        record={'status':'REFUSED','phase':'during','attemptId':attempt,'nonce':nonce,'durationSeconds':5,'barrierKey':'1-2','rootBarrierKey':root,'rootBarrierUid':1000,'rootBarrierGid':100,'rootBarrierMode':0o600,'uid':1000}
        A.validate_control(record,'during',attempt,nonce,probe,root,1000,100)
        for field,value in [('status','ACQUIRED'),('durationSeconds',4.9),('rootBarrierKey','7-8'),('rootBarrierUid',0),('rootBarrierMode',0o666),('durationSeconds',float('nan'))]:
            changed=dict(record);changed[field]=value
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):A.validate_control(changed,'during',attempt,nonce,probe,root,1000,100)


class BackendTests(unittest.TestCase):
    """Synthetic inspected metadata; no Docker/host operation is executed."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.home=self.root/'state/employees'/EMP/'home';self.tmp=self.root/'scratch/employees'/EMP/'tmp'
        self.home.mkdir(parents=True);self.tmp.mkdir(parents=True)
        self.company=self.root/'company.json';self.record={'id':EMP,'sessionId':SID,'sessionGeneration':1,'desiredRunning':True,'onVacation':False}
        self.write_company()
        config={'uid':os.getuid(),'gid':os.getgid(),'stateRoot':str(self.root/'state'),'scratchRoot':str(self.root/'scratch'),
                'companyFile':str(self.company),'deployment':'synthetic','image':'sha256:'+'a'*64,'socket':str(self.root/'general.sock'),'mounts':[],
                'leaseAcceptance':{'socket':str(self.root/'state/lease-peer/peer.sock'),'employeeId':EMP,'leaseSubdirectory':'.local/state/reverie/leases','peerBinary':'/nix/store/test-static/bin/peer'}}
        self.broker_file=self.root/'private/broker.json';self.broker_file.parent.mkdir();self.broker_file.write_text(json.dumps(config));self.broker_file.chmod(0o600)
        broker=type('B',(),{'config':config,'config_file':self.broker_file,'engine':sys.executable,'allowed':lambda _,sid:sid==SID})()
        artifact={'path':config['leaseAcceptance']['peerBinary'],'sha256':'c'*64,'inode':'1-2'}
        self.artifact_mock=patch.object(P.Artifact,'artifact',return_value=artifact);self.artifact_mock.start();self.addCleanup(self.artifact_mock.stop)
        self.backend=P.BrokerPeerBackend(broker)
        self.mounted=patch.object(P.Artifact,'mounted',return_value={});self.mounted.start();self.addCleanup(self.mounted.stop)
        self.row={'id':'d'*64,'image':config['image'],'name':'/synthetic-agent-'+SID,'labels':{'reverie.worker':'synthetic','reverie.session':SID},
                  'user':f'{os.getuid()}:{os.getgid()}','pid':os.getpid(),'running':True,
                  'mounts':[{'Destination':'/home/agent','Type':'bind','RW':True,'Source':str(self.home)},
                            {'Destination':'/tmp','Type':'bind','RW':True,'Source':str(self.tmp)}]}
        hashes=P.expected_labels(config,SID)
        self.row['labels'].update({'reverie.worker-config':hashes['workerConfigHash'],'reverie.worker-policy':hashes['workerPolicyHash']})
        self.calls=[]
        def metadata(*args):
            self.calls.append(args)
            if args[0]=='ps':return self.row['id']+'\n'
            if args[0]=='inspect':return json.dumps(self.row)+'\n'
            raise AssertionError('unexpected engine verb')
        self.backend._engine=metadata

    def write_company(self):self.company.write_text(json.dumps({'employees':[self.record]}));self.company.chmod(0o600)

    def test_current_registry_and_exact_running_image_mount_identity(self):
        binding=self.backend.resolve(EMP)
        self.assertEqual(binding['sessionId'],SID);self.assertEqual(binding['containerId'],self.row['id'])
        self.assertEqual(binding['home'],str(self.home));self.assertEqual(binding['tmp'],str(self.tmp))
        self.assertTrue(all(call[0] in ('ps','inspect') for call in self.calls))
        self.assertNotIn('.Config.Env',str(self.calls));self.assertNotIn('.Config.Cmd',str(self.calls))

    def test_missing_stopped_vacation_or_sleeping_employee_refuses(self):
        for field,value in [('desiredRunning',False),('desiredRunning',None),('onVacation',True),('sleeping',True),('sessionId',None),('sessionGeneration',None),('sessionGeneration',True),('sessionGeneration',0),('bindingMigration',{})]:
            old=dict(self.record);self.record[field]=value;self.write_company()
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):self.backend.resolve(EMP)
            self.record=old
        self.write_company()
        with self.assertRaises(ValueError):self.backend.resolve(str(uuid.uuid4()))

    def test_changed_image_user_labels_or_tmp_bind_refuses(self):
        original=copy.deepcopy(self.row)
        changes=[('image','sha256:'+'e'*64),('user','0:0'),('running',False),('pid',0),('labels',{'reverie.worker':'foreign','reverie.session':SID})]
        for field,value in changes:
            self.row=copy.deepcopy(original);self.row[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):self.backend.resolve(EMP)
        self.row=copy.deepcopy(original);self.row['mounts'][1]['Source']=str(self.home)
        with self.assertRaises(ValueError):self.backend.resolve(EMP)

    def test_actual_worker_control_socket_mount_refuses_even_readonly(self):
        self.row['mounts'].append({'Destination':'/exposed','Type':'bind','RW':False,'Source':str(Path(self.backend.option['socket']).parent)})
        with self.assertRaises(ValueError):self.backend.custody()

    def test_broker_custody_fences_authoritative_files_and_ancestors(self):
        self.backend.custody()
        for authority in (self.broker_file,self.company):
            alias=self.root/('alias-'+authority.name);alias.symlink_to(authority)
            for source in (authority,authority.parent,alias):
                grant={'source':str(source),'destination':'/exposed-authority','readOnly':False}
                self.backend.broker.config['mounts'].append(grant)
                with self.subTest(source=source,kind='configured'),self.assertRaises(ValueError):self.backend.custody()
                self.backend.broker.config['mounts'].pop()
                self.row['mounts'].append({'Source':str(source),'Destination':'/exposed-authority','Type':'bind','RW':True})
                with self.subTest(source=source,kind='actual'),self.assertRaises(ValueError):self.backend.custody()
                self.row['mounts'].pop()

    def test_root_inventory_fences_broker_and_registry_authority(self):
        config={'peerSocket':self.backend.option['socket'],'stateDirectory':str(self.root/'root-receipts'),
                'brokerConfig':str(self.broker_file),'companyFile':str(self.company),'peerEmployeeId':EMP,
                'peerBinary':self.backend.option['peerBinary']}
        deployment={'deployment':'synthetic','employee_ids':[EMP],'laptop_uid':os.getuid(),'laptop_gid':os.getgid(),
                    'laptop_home_root':str(self.root/'state/employees'),'b_mount':str(self.root/'scratch'),
                    'laptops_root':'employees','docker_socket':'/synthetic.sock'}
        def command(args):
            output=self.row['id']+'\n' if 'ps' in args else json.dumps(self.row)+'\n'
            return subprocess.CompletedProcess(args,0,output,'')
        self.assertEqual(len(A.metadata(config,deployment,Path('/synthetic-docker'),command,self.backend.broker.config)),1)
        for authority in (self.broker_file,self.company):
            alias=self.root/('root-alias-'+authority.name);alias.symlink_to(authority)
            for source in (authority,authority.parent,alias):
                self.row['mounts'].append({'Source':str(source),'Destination':'/exposed-authority','Type':'bind','RW':True})
                with self.subTest(source=source),self.assertRaises(ValueError):A.metadata(config,deployment,Path('/synthetic-docker'),command,self.backend.broker.config)
                self.row['mounts'].pop()

    def test_launch_is_fixed_nonroot_exec_into_existing_container(self):
        binding=self.backend.resolve(EMP)
        with patch.object(P.subprocess,'Popen') as spawn,patch.object(P,'HelperProcess'):
            self.backend.launch(binding,time.time()+120)
        args=spawn.call_args.args[0]
        self.assertEqual(args[1:3],['exec','-i'])
        self.assertEqual(args[args.index('--user')+1],f'{os.getuid()}:{os.getgid()}')
        self.assertIn(binding['containerId'],args)
        self.assertEqual(args[-1],P.Artifact.TARGET)
        self.assertNotIn('python3',args);self.assertNotIn('/bin/python3',args)
        self.assertNotIn('create',args);self.assertNotIn('start',args);self.assertNotIn('restart',args);self.assertNotIn('attach',args)
        self.assertTrue(spawn.call_args.kwargs['start_new_session'])


class FailureBoundTests(unittest.TestCase):
    def test_nonblocking_pipe_keeps_absolute_deadline_when_reader_stalls(self):
        child=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(10)'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,start_new_session=True)
        helper=P.HelperProcess(child,time.time()+30)
        try:
            fcntl.fcntl(child.stdin.fileno(),fcntl.F_SETPIPE_SZ,4096)
            start=time.monotonic()
            with self.assertRaises(ValueError):helper._write(b'x'*I.MAX_MESSAGE,start+.05)
            self.assertLess(time.monotonic()-start,.3)
        finally:
            child.terminate();helper.close()

    def test_streaming_command_limits_output_and_time(self):
        with self.assertRaises(ValueError):I.command([sys.executable,'-I','-B','-c','import sys;sys.stdout.write("x"*1000000)'],limit=4096)
        start=time.monotonic()
        with self.assertRaises(ValueError):I.command([sys.executable,'-I','-B','-c','import time;time.sleep(5)'],timeout=.05)
        self.assertLess(time.monotonic()-start,1.2)
        self.assertFalse(I.OWNED_UNCONFIRMED)

    def test_unexpected_fixture_contents_are_preserved_and_block_new_attempt(self):
        with tempfile.TemporaryDirectory() as t:
            backend=Fixture(t);server=P.PeerServer(backend)
            attempt=str(uuid.uuid4());nonce='a'*64
            request={'version':1,'method':'prepare','attemptId':attempt,'nonce':nonce,'employeeId':EMP,'expiresAt':time.time()+180}
            try:
                server.request(request)
                extra=backend.tmp/('.reverie-lease-gate-'+attempt)/'held/not-owned.txt';extra.write_text('preserve')
                start=time.monotonic()
                with self.assertRaises((ValueError,RuntimeError)):server.request({'version':1,'method':'retireOwn','attemptId':attempt,'nonce':nonce})
                self.assertLess(time.monotonic()-start,2)
                self.assertEqual(extra.read_text(),'preserve');self.assertIsNotNone(server.unconfirmed)
                with self.assertRaises(ValueError):server.request(dict(request,attemptId=str(uuid.uuid4())))
            finally:server.close();backend.cleanup()

    def test_failed_requalification_marks_old_success_unusable(self):
        class Host:
            def __init__(self):self.marks=[]
            def begin(self,attempt,nonce,status='RUNNING'):self.marks.append(status)
            def binding(self):raise I.Refused('current physical check failed')
        class Peer:
            def call(self,value):raise I.Refused('no synthetic active attempt')
        host=Host()
        with self.assertRaises(ValueError):A.run_acceptance({},host,Peer())
        self.assertEqual(host.marks,['RUNNING','FAILED'])


class StaticArtifactTests(unittest.TestCase):
    def production(self):
        path=os.environ.get('REVERIE_TEST_STATIC_PRODUCTION')
        if not path:self.skipTest('explicit static production artifact required; no qualification is inferred')
        return P.Artifact.artifact(path)

    def test_production_is_immutable_native_static_and_has_no_path_arguments(self):
        artifact=self.production();self.assertEqual(P.Artifact.artifact(artifact['path']),artifact)
        self.assertEqual(subprocess.run([artifact['path'],'/arbitrary/path'],timeout=5).returncode,64)
        with self.assertRaises(ValueError):P.Artifact.static_elf(b'#!/bin/sh\n')
        data=bytearray(Path(artifact['path']).read_bytes())
        import struct
        offset=struct.unpack_from('<Q',data,32)[0];struct.pack_into('<I',data,offset,3)
        with self.assertRaises(ValueError):P.Artifact.static_elf(bytes(data))

    def test_mount_flags_aliases_and_trace_or_remount_caps_refuse(self):
        artifact=self.production()
        base={'readOnlyRootfs':True,'privileged':False,'capAdd':[],'pid':os.getpid(),'mounts':[{'Destination':P.Artifact.TARGET,'Type':'bind','Source':artifact['path'],'RW':False}]}
        cases=[]
        for key,value in [('readOnlyRootfs',False),('privileged',True),('capAdd',['SYS_PTRACE']),('capAdd',['CAP_SYS_ADMIN'])]:
            row=copy.deepcopy(base);row[key]=value;cases.append(row)
        row=copy.deepcopy(base);row['mounts'][0]['RW']=True;cases.append(row)
        row=copy.deepcopy(base);row['mounts'][0]['Source']='/arbitrary/file';cases.append(row)
        for target in ['/','/opt','/bin','/opt/other']:
            row=copy.deepcopy(base);row['mounts'].append({'Destination':target,'Type':'bind','Source':'/arbitrary/path','RW':False});cases.append(row)
        for row in cases:
            with self.subTest(row=row),self.assertRaises(ValueError):P.Artifact.mounted(row,artifact)

    def test_only_selected_current_peer_policy_gets_artifact_mount(self):
        artifact=self.production()
        from reverie.worker_resources import effective_config,policy_digest
        with tempfile.TemporaryDirectory() as t:
            root=Path(t).resolve();company=root/'company.json';company.write_text(json.dumps({'employees':[{'id':EMP,'sessionId':SID}]}));company.chmod(0o600)
            before={'uid':os.getuid(),'socket':str(root/'broker.sock'),'stateRoot':str(root/'state'),'companyFile':str(company),'mounts':[],'image':'sha256:'+'a'*64}
            after=dict(before,leaseAcceptance={'socket':str(root/'state/peer/p.sock'),'employeeId':EMP,'leaseSubdirectory':'.local/state/reverie/leases','peerBinary':artifact['path']})
            foreign=str(uuid.uuid4());self.assertEqual(policy_digest(before,foreign),policy_digest(after,foreign))
            self.assertNotEqual(policy_digest(before,SID),policy_digest(after,SID))
            self.assertEqual(effective_config(after,SID)['mounts'],[{'source':artifact['path'],'destination':P.Artifact.TARGET,'readOnly':True}])


class ConfigAttestationTests(BackendTests):
    def test_wrong_or_stale_worker_config_and_policy_labels_refuse(self):
        for key in ('reverie.worker-config','reverie.worker-policy'):
            old=self.row['labels'][key];self.row['labels'][key]='f'*64
            with self.subTest(key=key),self.assertRaises(ValueError):self.backend.resolve(EMP)
            self.row['labels'][key]=old
        self.backend.broker.config['mounts'].append({'source':str(self.root/'extra'),'destination':'/extra','readOnly':True})
        with self.assertRaises(ValueError):self.backend.resolve(EMP)

    def test_configured_root_or_opt_grants_refuse_before_artifact_creation(self):
        config=copy.deepcopy(self.backend.broker.config)
        for target in ('/','/opt','/bin','/opt/unrelated'):
            config['mounts']=[{'source':str(self.root/'extra'),'destination':target,'readOnly':True}]
            with self.subTest(target=target),self.assertRaises(ValueError):P.validate_option(config)
