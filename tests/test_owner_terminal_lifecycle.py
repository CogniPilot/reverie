"""Owned files/OFDs/processes/UDS; no service, engine, website or employee action."""
from contextlib import contextmanager
import fcntl
import json
import os
import select
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reverie import owner_terminal_lifecycle as L
from reverie import owner_terminal_channel as C


class LockAndMetadata(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.path=self.root/'update.lock';self.path.write_bytes(b'');self.path.chmod(0o600)
        self.initial=L.InitialInstallation.__new__(L.InitialInstallation)
        self.initial.lock_path=self.path;self.initial.guard=lambda:{}
        self.fd=os.open(self.path,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC);self.addCleanup(os.close,self.fd)

    def test_real_held_OFD_is_required_and_caller_keeps_it_locked(self):
        with self.assertRaisesRegex(ValueError,'NOT_ALREADY_HELD'):
            with self.initial.maintenance(self.fd):self.fail('Unlocked FD admitted')
        fcntl.flock(self.fd,fcntl.LOCK_EX)
        with self.initial.maintenance(self.fd):pass
        probe=os.open(self.path,os.O_RDWR);self.addCleanup(os.close,probe)
        with self.assertRaises(BlockingIOError):fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
        with self.assertRaises(BlockingIOError):
            with self.initial.maintenance(probe):self.fail('Another OFD admitted')

    def test_replaced_lock_does_not_become_the_old_inherited_OFD(self):
        fcntl.flock(self.fd,fcntl.LOCK_EX)
        self.path.rename(self.root/'preserved.lock');self.path.write_bytes(b'');self.path.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'LOCK_CHANGED'):
            with self.initial.maintenance(self.fd):pass

    def test_company_data_bound_does_not_reuse_the_smaller_private_policy_bound(self):
        data=self.root/'company.json';data.write_bytes(b'{"owned":"'+b'a'*150000+b'"}');data.chmod(0o644)
        raw,signature=L._data_bytes(data,16<<20)
        self.assertEqual(len(json.loads(raw)['owned']),150000)
        with self.assertRaisesRegex(ValueError,'CUSTODY'):L._data_bytes(data,131072)
        with self.assertRaisesRegex(ValueError,'CUSTODY'):L._data_bytes(data,16<<20,private=True)

    def test_late_reader_change_to_an_earlier_file_is_detected_after_all_closes(self):
        a=self.root/'first.json';b=self.root/'last.json'
        for path in (a,b):path.write_text('{}');path.chmod(0o600)
        entries={a:L.private_bytes(a),b:L.private_bytes(b)};read=L.private_bytes
        def changed(path):
            result=read(path)
            if path==b:a.write_text('{"changed":true}')
            return result
        with patch.object(L,'private_bytes',side_effect=changed),self.assertRaisesRegex(ValueError,'PUBLICATION_CHANGED'):
            L._terminal_files(entries)
        self.assertEqual(a.read_text(),'{"changed":true}')

    def test_closed_CLI_rejects_mixed_phase_data_before_constructing_native_ports(self):
        with patch.object(L,'RuntimeManifest',side_effect=AssertionError('No native/manifest construction')):
            with self.assertRaises(SystemExit)as error:
                L.main(['--installation','/owned/config','describe','--container-id','a'*64],runtime_manifest={})
            self.assertEqual(error.exception.code,2)
            with self.assertRaises(SystemExit)as error:
                L.main(['--installation','/owned/config','settle'],runtime_manifest={})
            self.assertEqual(error.exception.code,2)


class NativeProcessMetadata(unittest.TestCase):
    def test_inventory_mount_order_is_canonical_but_all_fields_and_duplicates_remain(self):
        from reverie.owner_terminal_native import inventory
        mounts=[{'Type':'bind','Source':'/owned/a','Destination':'/a','RW':False,'Propagation':'rprivate'},
                {'Type':'bind','Source':'/owned/b','Destination':'/b','RW':True,'Extra':{'future':1}}]
        class Engine:
            def get(self,path):
                self_path=path
                assert self_path=='/containers/json?all=1'
                return [{'Id':'a'*64,'ImageID':'b'*64,'Names':['/own'],'Labels':{},'State':'running','Mounts':self.rows}]
        engine=Engine();engine.rows=mounts+[dict(mounts[0])]
        first=inventory(engine)
        engine.rows=list(reversed(engine.rows));self.assertEqual(inventory(engine),first)
        self.assertEqual(len(first[0]['Mounts']),3)
        engine.rows=[{**mounts[0],'RW':True},mounts[1],dict(mounts[0])]
        self.assertNotEqual(inventory(engine),first)
        engine.rows=[mounts[0],None]
        with self.assertRaisesRegex(ValueError,'LIVE_MOUNT_RECORD_REQUIRED'):inventory(engine)

    def test_actual_owned_listener_is_qualified_without_consuming_an_accept_slot(self):
        with tempfile.TemporaryDirectory()as directory:
            path=Path(directory).resolve()/'own.sock'
            script=('import socket,sys; s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); '
                    's.bind(sys.argv[1]);__import__("os").chmod(sys.argv[1],0o600);s.listen(2); '
                    'print("READY",flush=True);sys.stdin.buffer.read(1);s.close()')
            child=subprocess.Popen([sys.executable,'-I','-B','-c',script,str(path)],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
            try:
                self.assertEqual(child.stdout.readline(),b'READY\n')
                process=C.read_proc(child.pid);facts=L._listener(process,path)
                self.assertEqual(facts['processDigest'],C.digest(process))
                self.assertTrue(facts['kernelSocketInode'].isdecimal())
                self.assertIsNone(child.poll())
            finally:
                if child.poll() is None:
                    child.stdin.write(b'x');child.stdin.flush();child.wait(timeout=5)
                child.stdin.close();child.stdout.close()
            with self.assertRaises(FileNotFoundError):C.read_proc(child.pid)

    def test_actual_child_birth_must_be_gone_not_merely_asserted_by_a_receipt(self):
        child=subprocess.Popen([sys.executable,'-I','-B','-c',
            'import sys;print("READY",flush=True);sys.stdin.buffer.read(1)'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(),b'READY\n')
            process=C.read_proc(child.pid)
            self.assertFalse(L._pid_gone(process))
            child.stdin.write(b'x');child.stdin.flush();child.wait(timeout=5)
            self.assertTrue(L._pid_gone(process))
        finally:
            if child.poll() is None:child.terminate();child.wait(timeout=5)
            child.stdin.close();child.stdout.close()

    def test_populated_or_rebound_cgroup_refuses_even_after_client_exit(self):
        with tempfile.TemporaryDirectory()as directory,patch.object(L,'CGROUP',Path(directory)):
            root=Path(directory);group=root/'own.service';group.mkdir();(group/'cgroup.events').write_text('populated 1\nfrozen 0\n')
            info=group.stat();parent=root.stat();binding={'path':'/own.service',
                'identity':[str(info.st_dev),str(info.st_ino)],'parentIdentity':[str(parent.st_dev),str(parent.st_ino)],
                'ancestors':{'.':[str(parent.st_dev),str(parent.st_ino)]}}
            with self.assertRaisesRegex(ValueError,'POPULATED'):L._group_empty(binding)
            (group/'cgroup.events').write_text('populated 0\nfrozen 0\n');L._group_empty(binding)
            group.rename(root/'preserved.service');group.mkdir()
            with self.assertRaisesRegex(ValueError,'CHANGED'):L._group_empty(binding)


class ProjectionHandshake(unittest.TestCase):
    def test_actual_UDS_READY_is_deferred_until_explicit_host_initialization_and_cannot_replay(self):
        class Peer(C.WebsitePeer):
            def assert_process(self,credentials,stage):
                if self.calls:self.test.assertTrue(self.published)
                self.calls+=1
                return C.read_proc(credentials[0])
        peer=Peer.__new__(Peer);peer.calls=0;peer.published=False;peer.test=self
        handoff=C.Handoff(peer,timeout=120)
        client,server=socket.socketpair();handoff.state='NODE';handoff.process=C.read_proc(os.getpid())
        handoff.pidfd=os.pidfd_open(os.getpid());client.settimeout(.01)
        try:
            handoff.accept_node(server,acknowledge=False)
            with self.assertRaises(TimeoutError):client.recv(6)
            peer.published=True;handoff.acknowledge_node()
            self.assertEqual(client.recv(6),b'READY\n')
            with self.assertRaisesRegex(ValueError,'NO_REPLAY'):handoff.acknowledge_node()
        finally:handoff.close();client.close();server.close()


class GenerationFlow(unittest.TestCase):
    """Real generation files/flock/child births; fixed native ports controlled.

    The immutable image/program and service manager are explicit fixture ports,
    never an installed/native claim. Production has no callback selection API.
    """
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.control=self.root/'control';self.ledger=self.root/'ledger';self.boot=self.root/'bootstrap'
        for path in (self.control,self.ledger,self.boot):path.mkdir(mode=0o700)
        self.lock=self.root/'update.lock';self.write(self.lock,b'')
        self.fd=os.open(self.lock,os.O_RDWR|os.O_CLOEXEC);self.addCleanup(os.close,self.fd)
        fcntl.flock(self.fd,fcntl.LOCK_EX)
        self.eid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';self.sid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        self.cid='c'*64
        self.company=self.root/'company.json';self.worker=self.root/'worker.json';self.deploy=self.root/'deployment.json'
        self.write(self.company,L._encoded({'employees':[{'id':self.eid,'sessionId':self.sid,
            'sessionGeneration':1,'desiredRunning':False,'onVacation':True}]}))
        self.config={'uid':os.getuid(),'gid':os.getgid(),'companyFile':str(self.company),'memoryMiB':2048}
        self.write(self.worker,L._encoded(self.config))
        self.initial=L.InitialInstallation.__new__(L.InitialInstallation)
        self.initial.path=self.control/'initial.json';self.write(self.initial.path,b'{"private":"fixture"}')
        self.write(self.deploy,L._encoded({'websiteRuntime':'terminal','ownerTerminalConfig':str(self.initial.path)}))
        self.initial.roots={'controlBase':self.control,'ledgerBase':self.ledger,'bootstrapRoot':self.boot}
        self.initial.root_ids={name:L._directory_identity(path) for name,path in self.initial.roots.items()}
        self.initial.lock_path=self.lock;self.initial.deployment_path=self.deploy
        self.initial.value={'workerConfig':str(self.worker),'entitlements':[self.eid],
            'engine':{'socket':'/controlled/not-an-engine','identity':[1,2,3,4],'id':'controlled'},
            'externalOrigin':'http://fixture.invalid','ingressPeers':[]}
        runtime=L.RuntimeManifest.__new__(L.RuntimeManifest)
        runtime.pair={'path':'/nix/store/synthetic-runtime/manifest.json','sha256':'a'*64}
        runtime.value={'profile':'terminal','toolkitManifest':{'path':'/nix/store/synthetic-toolkit/manifest.json','sha256':'b'*64}}
        runtime.host_program={'executable':str(Path(sys.executable).resolve()),
            'argvPrefix':[sys.executable,'-I','-B',str(self.root/'fixed-host-fixture.py')]}
        self.initial.runtime=runtime;self.initial.host_program=runtime.host_program
        self.write(self.initial.path,L._encoded(self.initial.value))
        self.initial.identity=L.private_document(self.initial.path)[1]
        self.initial.engine_program=Path('/nix/store/synthetic-docker/bin/docker')
        def guard():
            self.initial.worker_selection=L.private_bytes(self.worker)
            return json.loads(self.worker.read_text())
        self.initial.guard=guard
        self.initial.derive_policy=lambda cid,spec,config:{'containerId':cid,'initPid':None,'initStart':None}
        # Kernel/engine producers remain explicit controlled ports in this generation fixture.
        self.initial._website_capacity=lambda *args,**kwargs:None
        self.unit=self.root/'unit.txt'
        self.initial.install_unit=lambda raw,old:self.write(self.unit,raw)
        self.unit_state={'LoadState':'loaded','MainPID':'0','ActiveState':'inactive','SubState':'dead',
            'Result':'success','ExecMainStatus':'0','InvocationID':'d'*32,'ControlGroup':'/own.service',
            'ExecMainCode':'1','FragmentPath':str(self.unit),'DropInPaths':''}
        self.initial.unit_state=lambda:dict(self.unit_state)
        self.spec=self.root/'approved-spec.json';self.write(self.spec,L._encoded({'Image':'sha256:'+'e'*64}))
        self.spec_sha=L._sha(self.spec.read_bytes())
        # Only actual image/kernel qualification is controlled here. Policy,
        # metadata publication, old journal, OFD, PID absence and CAS are real.
        class Installed:
            def __init__(self,path,expected):self.raw=L.private_bytes(path)[0];self.expected=expected
            def guard(self):L.need(L._sha(self.raw)==self.expected,'CONTROLLED_POLICY_HASH')
            def close(self):pass
        self.enterContext(patch('reverie.owner_terminal_native.Installation',Installed))

    @staticmethod
    def write(path,raw):
        path=Path(path);path.write_bytes(raw);path.chmod(0o600)

    def prepare(self):return self.initial.prepare_created(self.fd,self.cid,self.spec,self.spec_sha)

    def clean_receipt(self,result,*,alive=False):
        child=subprocess.Popen([sys.executable,'-I','-B','-c',
            'import sys;print("READY",flush=True);sys.stdin.buffer.read(1)'],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        def cleanup():
            try:
                if child.poll() is None:child.terminate()
                child.wait(timeout=5)
            finally:
                child.stdin.close();child.stdout.close()
        self.addCleanup(cleanup)
        try:
            # Popen's exec acknowledgement is not application readiness. Capture
            # process identity only once the owned child is waiting for input.
            self.assertTrue(select.select([child.stdout],[],[],5)[0],'Child readiness timeout')
            self.assertEqual(child.stdout.readline(),b'READY\n')
            process=C.read_proc(child.pid)
            if not alive:
                child.stdin.write(b'q');child.stdin.flush();child.wait(timeout=5)
        except BaseException:
            cleanup()
            raise
        group=self.root/'cgroup';group.mkdir(exist_ok=True);leaf=group/'own.service';leaf.mkdir(exist_ok=True)
        self.write(leaf/'cgroup.events',b'populated 0\nfrozen 0\n')
        info=leaf.stat();parent=group.stat()
        cg={'path':'/own.service','identity':[str(info.st_dev),str(info.st_ino)],
            'parentIdentity':[str(parent.st_dev),str(parent.st_ino)],
            'ancestors':{'.':[str(parent.st_dev),str(parent.st_ino)]}}
        self.enterContext(patch.object(L,'CGROUP',group))
        started={'process':process,'invocationId':'d'*32,'cgroup':cg,'unit':{}}
        root=Path(result['policyPath']).parent
        self.write(root/'SERVICE-START.json',L._encoded(started))
        self.write(root/'HOST-DRAINED.json',L._encoded({'schema':'reverie-owner-terminal-drained-v1',
            'policySHA256':result['policySHA256'],'process':process,'websiteBindingDigest':'f'*64,
            'shutdown':'REQUESTED','settlements':{}}))
        return child

    def test_clean_receipt_refuses_bad_readiness_before_identity_and_reaps_owned_child(self):
        first=self.prepare();popen=subprocess.Popen;children=[]
        def failed_start(argv,**kwargs):
            argv=list(argv);argv[-1]='import sys;print("NOT_READY",flush=True);sys.stdin.buffer.read(1)'
            child=popen(argv,**kwargs);children.append(child);return child
        try:
            with patch.object(subprocess,'Popen',side_effect=failed_start), \
                 patch.object(C,'read_proc',side_effect=AssertionError('Unexpected identity capture')) as identity:
                with self.assertRaises(AssertionError):self.clean_receipt(first)
                identity.assert_not_called()
            self.assertEqual(len(children),1)
            self.assertIsNotNone(children[0].poll())
            self.assertTrue(children[0].stdin.closed)
            self.assertTrue(children[0].stdout.closed)
        finally:
            # This also reaps the deliberately broken predecessor in the
            # regression control, even if its missing readiness fence fails.
            for child in children:
                if child.poll() is None:child.terminate()
                child.wait(timeout=5)
                if child.stdin is not None:child.stdin.close()
                if child.stdout is not None:child.stdout.close()

    def test_cold_prepare_then_actual_old_process_settlement_allows_fresh_same_CID_generation(self):
        first=self.prepare();selected,policy,_=self.initial.current()
        self.assertEqual(first['listenerState'],'NOT_STARTED')
        self.assertEqual(policy['entitlements'],{self.eid:{'sessionId':self.sid,'generation':1}})
        self.assertFalse((Path(first['policyPath']).parent/'START-ATTEMPT.json').exists())
        self.clean_receipt(first)
        # A fresh current transport is derived from canonical current rows;
        # no historical plan edge, old handle or human-title field participates.
        next_sid='99999999-9999-4999-8999-999999999999'
        self.config['memoryMiB']=4096;self.write(self.worker,L._encoded(self.config))
        self.write(self.company,L._encoded({'employees':[{'id':self.eid,'sessionId':next_sid,
            'sessionGeneration':2,'desiredRunning':False,'onVacation':True}]}))
        second=self.prepare();record,newpolicy,_=self.initial.current()
        self.assertNotEqual(first['generation'],second['generation'])
        self.assertEqual(first['containerId'],second['containerId'])
        self.assertEqual(newpolicy['workerConfigSHA256'],L._sha(self.worker.read_bytes()))
        self.assertEqual(newpolicy['entitlements'][self.eid],{'sessionId':next_sid,'generation':2})
        self.assertEqual(json.loads(self.company.read_text())['employees'][0]['desiredRunning'],False)
        self.assertTrue(Path(first['policyPath']).exists());self.assertIsNotNone(record['predecessor'])
        self.assertEqual(policy['workerConfigSHA256'],selected and L._sha(L._encoded({'uid':os.getuid(),
            'gid':os.getgid(),'companyFile':str(self.company),'memoryMiB':2048})))

    def test_canonical_drained_JSON_alone_cannot_clear_a_live_actual_child(self):
        first=self.prepare();child=self.clean_receipt(first,alive=True)
        with self.assertRaisesRegex(ValueError,'HOST_PROCESS_REMAINS'):self.initial.require_old_settled()
        self.assertIsNone(child.poll())
        with self.assertRaisesRegex(ValueError,'HOST_PROCESS_REMAINS'):self.prepare()

    def test_nonterminal_unknown_and_partial_namespace_are_preserved_not_replayed(self):
        first=self.prepare();policy=Path(first['policyPath'])
        with self.assertRaises(FileNotFoundError):self.prepare()
        self.assertTrue(policy.exists())
        pending=self.control/L.CONTROL_PENDING;self.write(pending,b'{"unknown":true}')
        with self.assertRaisesRegex(ValueError,'TRANSITION_UNKNOWN'):self.prepare()
        self.assertEqual(pending.read_bytes(),b'{"unknown":true}')

    def test_late_worker_policy_change_keeps_transition_fenced_without_restoring_owner_bytes(self):
        original=L._terminal_files
        def changed(entries,**kwargs):
            self.write(self.worker,L._encoded({**self.config,'memoryMiB':8192}))
            return original(entries,**kwargs)
        with patch.object(L,'_terminal_files',side_effect=changed),self.assertRaisesRegex(ValueError,'PUBLICATION_CHANGED'):
            self.prepare()
        self.assertTrue((self.control/L.CONTROL_PENDING).exists())
        self.assertEqual(json.loads(self.worker.read_text())['memoryMiB'],8192)

    def listener(self,result):
        """Actual owned listener, fixed service/kernel namespace ports controlled."""
        script=('import socket,sys,os;s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);'
                's.bind(sys.argv[1]);os.chmod(sys.argv[1],0o600);s.listen(2);'
                'print("READY",flush=True);sys.stdin.buffer.read(1);s.close()')
        child=subprocess.Popen([sys.executable,'-I','-B','-c',script,str(self.boot/'bootstrap.sock')],
                               stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        self.assertEqual(child.stdout.readline(),b'READY\n')
        def close():
            if child.poll()is None:child.stdin.write(b'q');child.stdin.flush();child.wait(timeout=5)
            child.stdin.close();child.stdout.close()
        self.addCleanup(close)
        process=C.read_proc(child.pid)
        binding={'process':process,'invocationId':'d'*32,'cgroup':{'controlled':True},'unit':{}}
        inactive=dict(self.unit_state)
        active={**inactive,'MainPID':str(child.pid),'ActiveState':'active','SubState':'running'}
        state=[inactive]
        self.initial.unit_state=lambda:dict(state[0])
        self.initial.manager=lambda action:state.__setitem__(0,active) if action=='start' else self.fail('Unexpected service action')
        self.initial.service_binding=lambda selected,policy:binding if selected==active else self.fail('Wrong active service')
        self.enterContext(patch.object(L.Path,'home',return_value=self.root))
        unit=self.root/'.config/systemd/user'/L.UNIT;unit.parent.mkdir(parents=True,mode=0o700)
        self.write(unit,self.initial.unit_text())
        self.enterContext(patch.object(C.Program,'matches',return_value=None))
        self.enterContext(patch.object(L,'_systemctl',side_effect=AssertionError('REAL_SERVICE_FORBIDDEN')))
        return child,binding

    def ready_ports(self,result,binding,*,late_close=None):
        import time
        root=Path(result['policyPath']).parent
        node=C.read_proc(os.getpid());website={'containerId':self.cid,'initPid':node['pid'],'initStart':node['start']}
        self.write(root/'HOST-CONNECTED.json',L._encoded({'schema':'reverie-owner-terminal-connected-v1',
            'policySHA256':result['policySHA256'],'process':binding['process'],
            'websiteBindingDigest':C.digest(website),'nodeProcess':node}))
        projection=self.boot/'current.json'
        self.write(projection,L._encoded({'available':True,'atEpochMs':int(time.time()*1000),
            'externalOrigin':self.initial.value['externalOrigin'],'ingressPeers':[]}))
        # This is the host-owned listener's normal retirement, in a synthetic
        # fixture only; no installed bootstrap socket is touched.
        (self.boot/'bootstrap.sock').unlink()
        class Installed:
            def __init__(self,path,sha):pass
            def bind_website_once(self):return website
            def assert_website(self):pass
            def close(self):
                if late_close:late_close()
        class Peer:
            def __init__(self,installed):pass
            def assert_process(self,credentials,stage):return C.read_proc(credentials[0])
        self.enterContext(patch('reverie.owner_terminal_native.Installation',Installed))
        self.enterContext(patch('reverie.owner_terminal_native.ProtectedWebsitePeer',Peer))
        return projection

    def test_connected_phase_sequence_uses_actual_listener_then_finalized_ready_projection(self):
        first=self.prepare();child,binding=self.listener(first)
        result=self.initial.start_listener(self.fd)
        self.assertEqual(result['listenerState'],'LISTENING');self.assertIsNone(child.poll())
        self.ready_ports(first,binding)
        self.assertEqual(self.initial.await_ready(self.fd)['state'],'PROTECTED_WEBSITE_READY')
        with self.assertRaisesRegex(ValueError,'SERVICE_ALREADY_ACTIVE'):self.initial.start_listener(self.fd)

    def test_host_exit_during_capacity_cannot_return_ready(self):
        first=self.prepare();child,binding=self.listener(first)
        self.initial.start_listener(self.fd);self.ready_ports(first,binding)
        def late(*args,**kwargs):
            child.stdin.write(b'q');child.stdin.flush();child.wait(timeout=5)
        self.initial._website_capacity=late
        with self.assertRaisesRegex(ValueError,'HOST_PROCESS_CHANGED'):self.initial.await_ready(self.fd)
        self.assertEqual(child.returncode,0)

    def test_node_exit_during_capacity_cannot_return_ready(self):
        first=self.prepare();host,binding=self.listener(first)
        self.initial.start_listener(self.fd);self.ready_ports(first,binding)
        node=subprocess.Popen([sys.executable,'-I','-B','-c','import sys;print("READY",flush=True);sys.stdin.buffer.read(1)'],
                              stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        self.assertEqual(node.stdout.readline(),b'READY\n')
        def cleanup():
            if node.poll() is None:node.terminate();node.wait(timeout=5)
            node.stdin.close();node.stdout.close()
        self.addCleanup(cleanup)
        path=Path(first['policyPath']).parent/'HOST-CONNECTED.json'
        value=L.private_document(path)[0];value['nodeProcess']=C.read_proc(node.pid)
        self.write(path,L._encoded(value))
        def late(*args,**kwargs):
            node.stdin.write(b'q');node.stdin.flush();node.wait(timeout=5)
        self.initial._website_capacity=late
        with self.assertRaisesRegex(ValueError,'NODE_PROCESS_CHANGED'):self.initial.await_ready(self.fd)
        self.assertEqual(node.returncode,0);self.assertIsNone(host.poll())

    def test_ready_projection_mutated_by_last_installed_finalizer_cannot_return_ready(self):
        first=self.prepare();_child,binding=self.listener(first);self.initial.start_listener(self.fd)
        projection=self.boot/'current.json'
        self.ready_ports(first,binding,late_close=lambda:self.write(projection,b'{"available":false}'))
        with self.assertRaisesRegex(ValueError,'PUBLICATION_CHANGED'):self.initial.await_ready(self.fd)
        self.assertEqual(projection.read_bytes(),b'{"available":false}')

    def test_listener_deadline_is_rechecked_after_last_native_producer_before_success(self):
        import time
        first=self.prepare();_child,binding=self.listener(first)
        real=time.monotonic;offset=[0];original=self.initial.service_binding
        def late(*args):
            value=original(*args);offset[0]=1000;return value
        self.initial.service_binding=late
        with patch.object(L.time,'monotonic',side_effect=lambda:real()+offset[0]):
            with self.assertRaisesRegex(ValueError,'LISTENER_DEADLINE'):self.initial.start_listener(self.fd)
        root=Path(first['policyPath']).parent
        self.assertTrue((root/'LISTENER-START-ATTEMPT.json').exists())
        self.assertFalse((root/'SERVICE-START.json').exists())

    def test_ready_deadline_is_rechecked_after_final_descriptor_cleanup(self):
        import time
        first=self.prepare();_child,binding=self.listener(first);self.initial.start_listener(self.fd)
        real=time.monotonic;offset=[0]
        self.ready_ports(first,binding,late_close=lambda:offset.__setitem__(0,1000))
        with patch.object(L.time,'monotonic',side_effect=lambda:real()+offset[0]):
            with self.assertRaisesRegex(ValueError,'READY_DEADLINE'):self.initial.await_ready(self.fd)

    def test_mode_changed_once_during_first_ready_native_read_is_preserved_and_refused(self):
        first=self.prepare();_child,binding=self.listener(first);self.initial.start_listener(self.fd)
        self.ready_ports(first,binding);original=self.initial.service_binding;changed=[False]
        def disable(*args):
            value=original(*args)
            if not changed[0]:
                changed[0]=True;self.write(self.deploy,L._encoded({'websiteRuntime':'default',
                    'ownerTerminalConfig':str(self.initial.path)}))
            return value
        self.initial.service_binding=disable
        with self.assertRaisesRegex(ValueError,'PUBLICATION_CHANGED'):self.initial.await_ready(self.fd)
        self.assertEqual(json.loads(self.deploy.read_text())['websiteRuntime'],'default')

    def test_prepare_owner_mode_change_during_unit_publication_retains_pending(self):
        original=self.initial.install_unit
        def disable(*args):
            result=original(*args)
            self.write(self.deploy,L._encoded({'websiteRuntime':'default','ownerTerminalConfig':str(self.initial.path)}))
            return result
        self.initial.install_unit=disable
        with self.assertRaisesRegex(ValueError,'PUBLICATION_CHANGED'):self.prepare()
        self.assertEqual(json.loads(self.deploy.read_text())['websiteRuntime'],'default')
        self.assertTrue((self.control/L.CONTROL_PENDING).exists())

    def _root_replacement(self,kind):
        first=self.prepare();_child,binding=self.listener(first);self.initial.start_listener(self.fd)
        self.ready_ports(first,binding);_,policy,_=self.initial.current()
        path=self.boot if kind=='bootstrapRoot' else Path(policy[kind])
        original=self.initial.service_binding;changed=[False];old=path.with_name(path.name+'-retained')
        def replace(*args):
            value=original(*args)
            if not changed[0]:
                changed[0]=True;path.rename(old);path.mkdir(mode=0o700)
                for entry in old.iterdir():entry.rename(path/entry.name)
            return value
        self.initial.service_binding=replace
        with self.assertRaisesRegex(ValueError,'H_LIFECYCLE_(ROOT_CHANGED|FINAL_NATIVE_CHANGED)'):
            self.initial.await_ready(self.fd)
        self.assertTrue(changed[0]);self.assertNotEqual(path.stat().st_ino,old.stat().st_ino)

    def test_bootstrap_root_replacement_during_native_work_refuses(self):
        self._root_replacement('bootstrapRoot')

    def test_selected_control_root_replacement_during_native_work_refuses(self):
        self._root_replacement('controlRoot')

    def test_selected_ledger_root_replacement_during_native_work_refuses(self):
        self._root_replacement('ledgerRoot')

    def test_listener_success_checks_budget_after_real_maintenance_finalizer(self):
        import time
        first=self.prepare();self.listener(first);original=self.initial.maintenance
        real=time.monotonic;offset=[0]
        @contextmanager
        def late(fd):
            with original(fd):yield
            offset[0]=1000
        self.initial.maintenance=late
        with patch.object(L.time,'monotonic',side_effect=lambda:real()+offset[0]):
            with self.assertRaisesRegex(ValueError,'LISTENER_DEADLINE'):self.initial.start_listener(self.fd)
        self.assertTrue((Path(first['policyPath']).parent/'LISTENER-START-ATTEMPT.json').exists())

    def test_owner_mode_disable_refuses_new_listener_without_waking_or_rebinding(self):
        first=self.prepare();self.write(self.deploy,L._encoded({'websiteRuntime':'default',
            'ownerTerminalConfig':str(self.initial.path)}))
        with self.assertRaisesRegex(ValueError,'OWNER_MODE_CHANGED'):self.initial.start_listener(self.fd)
        self.assertFalse((Path(first['policyPath']).parent/'LISTENER-START-ATTEMPT.json').exists())

    def test_policy_invalidated_clean_host_exit_can_rebind_only_after_fresh_physical_settlement(self):
        first=self.prepare();self.clean_receipt(first)
        path=Path(first['policyPath']).parent/'HOST-DRAINED.json';value=json.loads(path.read_text())
        value['shutdown']='POLICY_INVALIDATED';self.write(path,L._encoded(value))
        self.unit_state.update(ActiveState='failed',Result='exit-code',ExecMainStatus='1')
        self.initial.require_old_settled()
        self.unit_state['InvocationID']='e'*32
        with self.assertRaisesRegex(ValueError,'UNCONFIRMED_SERVICE_STOP'):self.initial.require_old_settled()

    def test_H_finalizer_failure_keeps_unknown_and_emits_no_settlement_marker(self):
        from reverie import owner_terminal_pty as H
        h=H.HumanTerminal.__new__(H.HumanTerminal);shell='11111111-1111-4111-8111-111111111111'
        h.digest='f'*64;h.assert_current_peer=lambda _:None;h.unknown={shell};h.settlements={}
        calls=[]
        class Channel:
            def close(self):calls.append('close');raise OSError('owned channel close uncertainty')
        child=SimpleNamespace(pid=42,stdin=None,stdout=None,returncode=0,poll=lambda:0)
        descriptor=os.open('/dev/null',os.O_RDONLY|os.O_CLOEXEC)
        h.sessions={shell:{'child':child,'pidfd':descriptor,'channel':Channel(),
            'settled':True,'buffer':bytearray(),'target':{},'ready':{},'binding':{'pid':42,'start':1},'targetCgroup':{}}}
        h.installation=SimpleNamespace(assert_guest_gone=lambda *_:None)
        h.marker=lambda *_:self.fail('Finalizer uncertainty cannot emit settled history')
        with self.assertRaisesRegex(RuntimeError,'CLEANUP_UNCONFIRMED'):h.finish(shell)
        self.assertEqual(calls,['close']);self.assertEqual(h.unknown,{shell});self.assertEqual(h.sessions,{})
        self.assertFalse(h.settlements)
        with self.assertRaises(OSError):os.fstat(descriptor)

    def test_legacy_handoff_keeps_default_budget_and_immediate_READY(self):
        class Peer(C.WebsitePeer):
            def assert_process(self,credentials,stage):return C.read_proc(credentials[0])
        handoff=C.Handoff(Peer.__new__(Peer));client,server=socket.socketpair()
        handoff.state='NODE';handoff.process=C.read_proc(os.getpid());handoff.pidfd=os.pidfd_open(os.getpid())
        try:
            handoff.accept_node(server);self.assertEqual(client.recv(6),b'READY\n')
            self.assertTrue(handoff.node_acknowledged)
        finally:handoff.close();client.close();server.close()


if __name__=='__main__':unittest.main()


class StoppedWebsiteCapacity(unittest.TestCase):
    """Real canonical stores/OFD and kernel-file reads; controlled metadata GETs only."""
    def setUp(self):
        import copy
        from tests import test_worker_resource_reservations as fixture
        self.f=fixture.Reservations();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.g=GenerationFlow();self.g.setUp();self.addCleanup(self.g.doCleanups)
        self.f.native.rows[1]['State'].update(Running=False,Pid=0)
        f=self.f
        class Engine:
            def get(self,route):
                if route=='/containers/json?all=1':return [{'Id':row['Id']} for row in f.native.rows]
                if route.startswith('/containers/') and route.endswith('/json'):
                    cid=route.split('/')[2]
                    return copy.deepcopy(next(row for row in f.native.rows if row['Id']==cid))
                raise AssertionError('No native/engine mutation or arbitrary route')
            def guard(self):pass
        self.initial=self.g.initial;self.initial.engine=Engine()
        self.g.write(self.g.worker,L._encoded(f.config))
        self.initial._website_capacity=L.InitialInstallation._website_capacity.__get__(self.initial)
        self.cid=f.native.rows[1]['Id']
        def derive(cid,spec,config):
            L.need(cid==self.cid,'H_LIFECYCLE_CREATED_BINDING_CHANGED')
            row=f.native.rows[1]
            return {'containerId':cid,'imageId':row['Image'],'configDigest':L.digest(row['Config']),
                'hostConfigDigest':L.digest(L.host_config(row['HostConfig'])),
                'mountsDigest':L.digest(L.mounts(row['Mounts']))}
        f.native.rows[1]['HostConfig']['OomKillDisable']=False
        self.initial.derive_policy=derive

    def capacity(self,*,stopped=True):
        import time
        return self.initial._website_capacity(self.f.config,self.cid,stopped=stopped,deadline=time.monotonic()+30)

    def preflight(self):return self.initial.preflight_created(self.g.fd,self.cid,self.g.spec,self.g.spec_sha)

    def test_valid_stopped_capacity_uses_actual_admission_and_does_not_publish(self):
        journal=self.f.control/'operations/operations.json';before=journal.read_bytes()
        result=self.preflight()
        self.assertEqual(result,{'version':1,'state':'STOPPED_WEBSITE_CAPACITY_QUALIFIED',
            'containerId':self.cid,'specSHA256':self.g.spec_sha,'workerEffects':False})
        self.assertEqual(journal.read_bytes(),before)
        self.assertFalse((self.g.control/L.CONTROL_CURRENT).exists())
        self.assertFalse((self.g.control/L.CONTROL_PENDING).exists())
        self.assertTrue(all(call[0] in ('ps','inspect') for call in self.f.native.calls))

    def test_peer_published_during_admission_exit_cannot_escape_final_bracket(self):
        from reverie import worker_resource_reservations as R
        capacity=R.NativeObserver.capacity_stopped_website;custody=R.NativeObserver.custody
        calls=[];changed=[]
        def count(native,rows,selected,cid):
            result=capacity(native,rows,selected,cid);calls.append(True);return result
        def late(native,*args,**kwargs):
            import inspect
            frames={frame.function for frame in inspect.stack()}
            if len(calls)==2 and not changed and 'admission' in frames and 'check_headroom' not in frames:
                peer=self.f.native.row('3'*64,'late-peer',125,8192,{'reverie.worker':'other'})
                self.f.kernel(peer);self.f.native.rows.append(peer);changed.append(True)
            return custody(native,*args,**kwargs)
        with patch.object(R.NativeObserver,'capacity_stopped_website',new=count), \
             patch.object(R.NativeObserver,'custody',new=late), \
             self.assertRaisesRegex(ValueError,'H_LIFECYCLE_CAPACITY_CHANGED'):
            self.capacity()
        self.assertEqual(len(calls),2);self.assertEqual(changed,[True])

    def test_exact_global_pool_candidate_and_reserve_arithmetic(self):
        from reverie import worker_resource_reservations as R
        f=self.f;f.config['poolMemoryMiB']=51200
        (f.proc/'meminfo').write_text('MemTotal: 65743872 kB\nMemAvailable: 41943040 kB\n')
        selected=dict(f.config['resourceReservations'],hostReserveMiB=4096)
        site=f.native.rows[1]
        for gib,refuse in [(8,False),(16,True)]:
            site['HostConfig'].update(Memory=gib*(1<<30),MemorySwap=gib*(1<<30))
            with self.subTest(gib=gib):
                if refuse:
                    with self.assertRaisesRegex(ValueError,'HOST_BUDGET'):
                        f.gate.native.capacity_stopped_website(f.native.rows,selected,self.cid)
                else:
                    result=f.gate.native.capacity_stopped_website(f.native.rows,selected,self.cid)
                    self.assertEqual(result[2]['declaredMemory'],8*(1<<30))
                    self.assertNotIn('pid',result[2])

    def test_retained_claim_is_charged_and_unknown_source_refuses(self):
        f=self.f
        # Claim before stopping the site uses its original genuine running fixture.
        f.native.rows[1]['State'].update(Running=True,Pid=124)
        f.claim();f.native.rows[1]['State'].update(Running=False,Pid=0)
        journal=f.control/'operations/operations.json';before=journal.read_bytes()
        self.capacity();self.assertEqual(journal.read_bytes(),before)
        # 7 GiB source + retained 2 GiB cannot fit the actual 8 GiB pool.
        f.native.rows[0]['HostConfig'].update(Memory=7*(1<<30),MemorySwap=7*(1<<30))
        (f.cgroup/'fixture-123/memory.max').write_text(str(7*(1<<30)))
        with self.assertRaises(ValueError):self.capacity()
        self.assertEqual(journal.read_bytes(),before)

    def test_stopped_identity_and_missing_or_unbounded_limits_refuse(self):
        import copy
        f=self.f;original=copy.deepcopy(f.native.rows[1])
        cases=[('State','Running',True),('State','Pid',124),('HostConfig','Memory',0),
               ('HostConfig','MemorySwap',-1),('HostConfig','PidsLimit',None),
               ('HostConfig','Memory',True),('Id',None,'f'*64)]
        for section,key,value in cases:
            f.native.rows[1]=copy.deepcopy(original)
            if key is None:f.native.rows[1][section]=value
            else:f.native.rows[1][section][key]=value
            with self.subTest(section=section,key=key),self.assertRaises((ValueError,StopIteration)):
                self.capacity()

    def test_config_spec_and_owner_mode_changes_during_native_io_refuse(self):
        for target in (self.g.worker,self.g.spec,self.g.deploy):
            raw=target.read_bytes();original=self.initial.engine.get;changed=[]
            def mutate(route):
                value=original(route)
                if not changed:target.write_bytes(raw+b' ');changed.append(True)
                return value
            with self.subTest(target=target.name),patch.object(self.initial.engine,'get',side_effect=mutate),\
                 self.assertRaisesRegex(ValueError,'PUBLICATION_CHANGED'):
                self.preflight()
            target.write_bytes(raw)

    def test_unknown_host_hierarchy_or_legacy_removed_domain_never_falls_back(self):
        from reverie import worker_resource_reservations as R
        with patch.object(R.NativeObserver,'host_root',side_effect=ValueError('unknown host hierarchy')):
            with self.assertRaisesRegex(ValueError,'unknown host'):self.capacity()
        del self.f.config['resourceReservations']
        with self.assertRaises(ValueError):self.capacity()

    def test_running_ready_check_requires_real_kernel_limits(self):
        from reverie import worker_resource_reservations as R
        self.f.native.rows[1]['State'].update(Running=True,Pid=124)
        self.capacity(stopped=False)
        (self.f.cgroup/'fixture-124/memory.max').write_text('max')
        with self.assertRaisesRegex(ValueError,'EFFECTIVE_LIMIT_CONFLICT'):self.capacity(stopped=False)

    def test_legacy_absence_uses_actual_site_plus_conservative_margin(self):
        import copy,time
        config=copy.deepcopy(self.f.config);config.pop('resourceReservations')
        config['stateRoot']=str(self.g.root/'legacy-state')
        Path(config['stateRoot']).mkdir(mode=0o700)
        # 8 GiB pool + 1 GiB actual site + legacy 8 GiB cannot fit 90% of 16 GiB.
        with self.assertRaisesRegex(ValueError,'LEGACY_HOST_BUDGET'):
            self.initial._website_capacity(config,self.cid,stopped=True,deadline=time.monotonic()+30)
        (self.f.proc/'meminfo').write_text('MemTotal: 33554432 kB\nMemAvailable: 25165824 kB\n')
        self.initial._website_capacity(config,self.cid,stopped=True,deadline=time.monotonic()+30)


class MaintenanceIdle(unittest.TestCase):
    def setUp(self):
        self.case=StoppedWebsiteCapacity();self.case.setUp();self.addCleanup(self.case.doCleanups)
        self.initial,self.f=self.case.initial,self.case.f
        self.stops=[]
        self.initial.require_old_settled=lambda:self.stops.append('old-settlement-check')
        self.initial.manager=lambda *args:self.stops.append(args)

    def test_empty_idle_domain_allows_readonly_initial_settle(self):
        raw=(self.f.control/'operations/operations.json').read_bytes()
        value=self.initial.settle(self.case.g.fd)
        self.assertEqual(value['state'],'INITIAL_EMPTY')
        self.assertEqual(self.stops,['old-settlement-check'])
        self.assertEqual((self.f.control/'operations/operations.json').read_bytes(),raw)

    def test_active_claim_or_orphan_pending_refuses_before_any_H_stop(self):
        self.f.native.rows[1]['State'].update(Running=True,Pid=124)
        self.f.claim()
        with self.assertRaisesRegex(ValueError,'RESOURCE_WORK_ACTIVE'):
            self.initial.settle(self.case.g.fd)
        self.assertEqual(self.stops,[])

    def test_host_job_unknown_or_removed_option_refuses_before_any_H_stop(self):
        from reverie import worker_host_job as W
        path=self.f.control/'operations'/W.FINISHING
        self.case.g.write(path,b'{}')
        with self.assertRaisesRegex(ValueError,'HOST_JOB_FINISH'):
            self.initial.settle(self.case.g.fd)
        self.assertEqual(self.stops,[])
        path.unlink();del self.f.config['resourceReservations']
        self.case.g.write(self.case.g.worker,L._encoded(self.f.config))
        with self.assertRaises(ValueError):self.initial.settle(self.case.g.fd)
        self.assertEqual(self.stops,[])

    def test_common_flock_remains_held_through_H_drain_body(self):
        def check():
            probe=os.open(self.f.control/'admission.lock',os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(probe)
            self.stops.append('drained-under-common-lock')
        self.initial.require_old_settled=check
        self.initial.settle(self.case.g.fd)
        self.assertEqual(self.stops,['drained-under-common-lock'])

    def test_actual_completed_history_does_not_permanently_block_maintenance(self):
        import time
        from tests.test_worker_resource_finalization import ResourceFinalization
        from reverie import worker_resource_finalization as S
        f=ResourceFinalization();f.setUp();self.addCleanup(f.doCleanups)
        S.complete(f.owner,f.key,f.proof)
        # Reuse this accepted fixture's controlled metadata-only native port;
        # all actual canonical reader/settlement/fence logic remains real.
        with patch.object(L,'_CapacityProbe',return_value=f.owner.gate.broker):
            with self.initial._maintenance_idle(f.owner.gate.broker.config,time.monotonic()+30):
                pass
