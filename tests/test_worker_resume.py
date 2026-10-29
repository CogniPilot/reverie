"""Owned real R stores/OFDs and actual Unix sender credentials; no engine/model.

Website/program metadata is controlled in transaction fixtures. These tests do
not turn a source fixture into native registration or running-provider proof.
"""
from contextlib import contextmanager
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch,Mock

from reverie import worker_resume as M
from reverie import worker_resume_peer as P
from reverie import resource_actor_bootstrap as B
from reverie.worker import Broker,send_frame
from tests import test_worker_resource_reservations as F
from tests.test_resource_actor_install import model_nix_fixture_ancestry

OP='44444444-4444-4444-8444-444444444444'


class ResumeTransactions(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(Broker,'run_engine',side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')))
        model_nix_fixture_ancestry(self)
        self.f=F.Reservations();self.f.setUp();self.addCleanup(self.f.doCleanups)
        f=self.f;f.native.resource_reservations=f.gate;f.native.stopping=threading.Event()
        f.employee['runtimeRecipe']={'mode':'codex','workingDir':'/workspace','configs':{}}
        f.company();self.owner=(os.getpid(),os.getuid(),os.getgid());self.calls=[];self.fault=None
        f.native.config_file=f.root/'broker.json';f.native.config_file.write_bytes(M.encoded(f.config));f.native.config_file.chmod(0o600)
        self.deployment=f.root/'deployment';self.deployment.mkdir(mode=0o700)
        self.definition=self.deployment/'deployment.json'
        self.definition.write_text(json.dumps({'version':1,'containerName':f.config['serverContainer'],
                                             'companyRoot':f.config['companyRoot']}));self.definition.chmod(0o600)
        self.lock=self.deployment/'runtime/update-state/update.lock';self.lock.parent.mkdir(mode=0o700,parents=True)
        self.lock.write_bytes(b'');self.lock.chmod(0o600)
        test=self
        class Website:
            def final_code(self,**kwargs):
                if test.fault=='terminal-code':raise ValueError('CONTROLLED_CODE_CHANGED')
        class Stream:
            state='CONNECTED';website=Website()
            def call(self,verb,value,deadline,**kwargs):
                test.calls.append(verb)
                if verb=='describe':
                    rows=[{**row,'savedDigest':'c'*64}for row in M.cohort(f.native)]
                    return {'cohort':rows,'snapshotDigest':M.digest(M.encoded(rows).rstrip(b'\n'))}
                test.assertEqual(verb,'wake')
                # Normal J must be able to take admission, while the actual
                # deployment maintenance OFD remains locked for this batch.
                with (f.control/'admission.lock').open('r+')as admission:
                    fcntl.flock(admission,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with test.lock.open('r+')as maintenance:
                    with test.assertRaises(BlockingIOError):fcntl.flock(maintenance,fcntl.LOCK_EX|fcntl.LOCK_NB)
                if test.fault=='ack-loss':raise EOFError('CONTROLLED_ACK_LOSS')
                row=value['employee']
                return {**{k:row[k]for k in ('employeeId','sessionId','generation')},'state':'already-live'}
        self.stream=Stream();self.service=M.HostWorkerResume(f.native,'/not-a-program')
        self.service.stream=self.stream
        self.before={p:str(p.read_bytes())for p in (F.Path(f.config['companyFile']),f.control/'operations/operations.json',
                                                   f.control/'profiles/profiles.json')}

    def prepare(self,operation=OP):
        snapshot=self.service.dispatch({'action':'worker-resume-describe'},self.owner)
        return self.service.dispatch({'action':'prepare-worker-resume','operationId':operation,
            'expectedSnapshotDigest':snapshot['snapshotDigest'],'deploymentPath':str(self.definition)},self.owner)

    def apply(self,plan):
        return self.service.dispatch({'action':'apply-worker-resume','operationId':plan['operationId'],
                                     'planDigest':plan['planDigest']},self.owner)

    def test_real_store_batch_holds_common_maintenance_but_not_creation_admission(self):
        plan=self.prepare();self.assertFalse(plan['capacityHeld']);self.assertFalse(plan['nativeEffects'])
        result=self.apply(plan);self.assertEqual(result['state'],'RESUME_BATCH_CONFIRMED')
        self.assertFalse(result['retryAllowed']);self.assertEqual(self.calls.count('wake'),1)
        self.assertFalse((self.f.control/'host-resume/ACTIVE.json').exists())
        self.assertTrue((self.f.control/'host-resume'/OP/'ATTEMPT.json').exists())
        for path,raw in self.before.items():self.assertEqual(str(path.read_bytes()),raw)
        self.assertTrue(all(call[0]in('ps','inspect')for call in self.f.native.calls))
        with self.assertRaisesRegex(ValueError,'NO_REPLAY'):self.apply(plan)

    def test_lost_ack_retains_unknown_across_new_controller_and_cannot_replay(self):
        plan=self.prepare();self.fault='ack-loss'
        with self.assertRaises(EOFError):self.apply(plan)
        active=self.f.control/'host-resume/ACTIVE.json';self.assertTrue(active.exists())
        cold=M.HostWorkerResume(self.f.native,'/not-a-program');cold.stream=self.stream
        with self.assertRaisesRegex(ValueError,'NO_REPLAY'):
            cold.dispatch({'action':'apply-worker-resume','operationId':OP,'planDigest':plan['planDigest']},self.owner)
        status=cold.dispatch({'action':'worker-resume-status','operationId':OP},self.owner)
        self.assertEqual(status['state'],'UNKNOWN_NOT_REPLAYABLE');self.assertEqual(self.calls.count('wake'),1)

    def test_off_vacation_new_generation_and_recipe_drift_win_before_attempt(self):
        for change in ('off','vacation','generation','recipe'):
            with self.subTest(change=change):
                operation=str(uuid.uuid4());plan=self.prepare(operation);before=copy.deepcopy(self.f.employee)
                if change=='off':self.f.employee['desiredRunning']=False
                elif change=='vacation':self.f.employee['onVacation']=True
                elif change=='generation':self.f.employee['sessionGeneration']+=1
                else:self.f.employee['runtimeRecipe']['configs']={'codexConfig':{'model':'changed-model'}}
                self.f.company()
                try:
                    with self.assertRaisesRegex(ValueError,'SNAPSHOT_CHANGED'):self.apply(plan)
                    self.assertFalse((self.f.control/'host-resume'/operation/'ATTEMPT.json').exists())
                finally:self.f.employee=before;self.f.company()
        self.assertNotIn('wake',self.calls)

    def test_foreign_fence_at_result_finalizer_is_preserved(self):
        plan=self.prepare();original=M.publish;active=self.f.control/'host-resume/ACTIVE.json';foreign=b'{"foreign":true}\n'
        def publish(path,value):
            result=original(path,value)
            if path.name=='RESULT.json':
                replacement=active.with_suffix('.foreign');replacement.write_bytes(foreign);replacement.chmod(0o600);replacement.replace(active)
            return result
        with patch.object(M,'publish',side_effect=publish),self.assertRaisesRegex(ValueError,'TERMINAL_CHANGED'):
            self.apply(plan)
        self.assertEqual(active.read_bytes(),foreign)

    def test_failed_unlink_sync_stays_unknown_even_when_active_is_already_absent(self):
        plan=self.prepare();original=M.sync;root=self.f.control/'host-resume'
        def sync(path):
            if path==root and (root/OP/'RESULT.json').exists() and not (root/'ACTIVE.json').exists():
                raise OSError('CONTROLLED_TERMINAL_SYNC_FAILURE')
            return original(path)
        with patch.object(M,'sync',side_effect=sync),self.assertRaisesRegex(OSError,'TERMINAL_SYNC'):
            self.apply(plan)
        self.assertFalse((root/'ACTIVE.json').exists())
        self.assertFalse((root/OP/'COMPLETE.json').exists())
        with self.assertRaisesRegex(ValueError,'UNKNOWN_BATCH_RETAINED'):self.prepare(str(uuid.uuid4()))
        with self.assertRaisesRegex(ValueError,'NO_REPLAY'):self.apply(plan)
        self.assertEqual(self.calls.count('wake'),1)

    def test_late_parent_finalizer_cannot_delete_replaced_active_leaf(self):
        plan=self.prepare();root=self.f.control/'host-resume';active=root/'ACTIVE.json';foreign=b'{"late":true}\n'
        original=B._parents_current;changed=[]
        def current(parents):
            original(parents)
            if not changed and str(root/OP)in parents and (root/OP/'RESULT.json').exists():
                temp=active.with_suffix('.late');temp.write_bytes(foreign);temp.chmod(0o600);temp.replace(active);changed.append(True)
        with patch.object(B,'_parents_current',side_effect=current),self.assertRaisesRegex(ValueError,'FENCE_CHANGED'):
            self.apply(plan)
        self.assertTrue(changed);self.assertEqual(active.read_bytes(),foreign)

    def test_expired_plan_after_durable_step_cannot_start_another_wake(self):
        plan=self.prepare();path=self.f.control/'host-resume'/OP;selected=json.loads((path/'PLAN.json').read_bytes())
        now=[M.time.time()];original=M.publish;changed=[]
        def publish(path,value):
            result=original(path,value)
            if path.name.startswith('STEP-'):now[0]=selected['expiresAt']+1;changed.append(True)
            return result
        with patch.object(M,'publish',side_effect=publish),patch.object(M.time,'time',side_effect=lambda:now[0]),\
             self.assertRaisesRegex(ValueError,'PLAN_EXPIRED'):self.apply(plan)
        self.assertTrue(changed);self.assertNotIn('wake',self.calls)
        self.assertTrue((path.parent/'ACTIVE.json').exists());self.assertFalse((path/'COMPLETE.json').exists())

    def test_owner_and_config_leaf_changes_after_last_parent_producer_retain_fence(self):
        for change in ('owner','config'):
            with self.subTest(change=change):
                # Each independent phase uses its own real stores/journal.
                case=ResumeTransactions();case.setUp()
                try:
                    plan=case.prepare();root=case.f.control/'host-resume';operation=root/OP
                    original=B._parents_current;changed=[]
                    def parents(value):
                        original(value)
                        if not changed and str(operation)in value and (operation/'RESULT.json').exists():
                            if change=='owner':case.f.employee['desiredRunning']=False;case.f.company()
                            else:case.f.native.config_file.write_bytes(M.encoded({**case.f.config,'cpus':1.0}))
                            changed.append(True)
                    with patch.object(B,'_parents_current',side_effect=parents),\
                         self.assertRaisesRegex(ValueError,'TERMINAL_METADATA_CHANGED'):case.apply(plan)
                    self.assertTrue(changed);self.assertTrue((root/'ACTIVE.json').exists())
                    self.assertFalse((operation/'COMPLETE.json').exists())
                finally:case.doCleanups()

    def test_staged_completion_real_close_failure_preserves_unknown(self):
        plan=self.prepare();root=self.f.control/'host-resume';path=root/OP;original=os.close;failed=[]
        def close(fd):
            try:selected=os.readlink('/proc/self/fd/'+str(fd))
            except OSError:selected=''
            original(fd)
            if selected==str(path/'COMPLETE.next.json')and not failed:
                failed.append(True);raise OSError('CONTROLLED_COMPLETION_CLOSE')
        with patch.object(M.os,'close',side_effect=close),self.assertRaisesRegex(OSError,'COMPLETION_CLOSE'):
            self.apply(plan)
        self.assertTrue(failed);self.assertTrue((root/'ACTIVE.json').exists())
        self.assertFalse((path/'COMPLETE.json').exists())
        with self.assertRaisesRegex(ValueError,'UNKNOWN_BATCH_RETAINED'):self.prepare(str(uuid.uuid4()))

    def test_owner_edit_inside_last_actual_directory_sync_cannot_commit_completion(self):
        plan=self.prepare();root=self.f.control/'host-resume';path=root/OP;original=M.sync;changed=[]
        def sync(target):
            result=original(target)
            if target==root and (path/'COMPLETE.next.json').exists() and not(root/'ACTIVE.json').exists() and not changed:
                self.f.employee['desiredRunning']=False;self.f.company();changed.append(True)
            return result
        with patch.object(M,'sync',side_effect=sync),self.assertRaisesRegex(ValueError,'TERMINAL_METADATA_CHANGED'):
            self.apply(plan)
        self.assertTrue(changed);self.assertFalse((path/'COMPLETE.json').exists())
        self.assertFalse((root/'ACTIVE.json').exists())
        with self.assertRaisesRegex(ValueError,'UNKNOWN_BATCH_RETAINED'):self.prepare(str(uuid.uuid4()))

    def test_replaced_purpose_root_or_operation_directory_does_not_revive_a_plan(self):
        plan=self.prepare();root=self.f.control/'host-resume';old=root.with_name('host-resume-old')
        root.rename(old);root.mkdir(mode=0o700);(old/OP).rename(root/OP)
        with self.assertRaisesRegex(ValueError,'NAMESPACE_CHANGED'):self.apply(plan)
        self.assertFalse((root/OP/'ATTEMPT.json').exists())

    def test_arbitrary_command_or_owner_flag_is_never_a_control(self):
        for extra in ({'owner':True},{'command':'anything'},{'recipe':{}},{'caller':'owner'}):
            with self.subTest(extra=extra),self.assertRaisesRegex(ValueError,'CLOSED_SCHEMA'):
                self.service.dispatch({'action':'worker-resume-describe',**extra},self.owner)
        self.assertEqual(self.calls,[])


class ActualHostCredentials(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(Broker,'run_engine',side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')))

    def exchange(self,foreign=False):
        from types import SimpleNamespace
        service=M.HostWorkerResume(SimpleNamespace(config={'uid':os.getuid()}),'/not-a-program')
        server,client=socket.socketpair();errors=[];calls=[]
        credentials=(os.getpid(),os.getuid(),os.getgid())
        def dispatch(value,peer):calls.append((value,peer));return {'confirmed':True}
        def accept():
            try:service.accept_owner(server,credentials)
            except BaseException as error:errors.append(error)
        with patch.object(service,'dispatch',side_effect=dispatch):
            thread=threading.Thread(target=accept);thread.start()
            try:
                self.assertEqual(client.recv(64),b'HOST_RESUME_OWNER_READY\n')
                if foreign:
                    program=("import socket,struct,sys; s=socket.socket(fileno=int(sys.argv[1]));"
                        "b=b'{\"action\":\"worker-resume-describe\"}';s.sendall(b'C'+struct.pack('!I',len(b))+b)")
                    child=subprocess.run([sys.executable,'-I','-B','-c',program,str(client.fileno())],
                        pass_fds=(client.fileno(),),capture_output=True,timeout=5)
                    self.assertEqual(child.returncode,0);self.assertEqual(child.stdout+child.stderr,b'')
                else:send_frame(client,b'C',b'{"action":"worker-resume-describe"}')
                thread.join(3);self.assertFalse(thread.is_alive())
            finally:client.close();server.close();thread.join(3)
        return calls,errors

    def test_actual_host_writer_is_accepted_after_fixed_ready_barrier(self):
        calls,errors=self.exchange();self.assertEqual(errors,[]);self.assertEqual(len(calls),1)

    def test_inherited_descriptor_writer_cannot_borrow_creator_peer_credentials(self):
        calls,errors=self.exchange(foreign=True);self.assertEqual(calls,[])
        self.assertEqual(len(errors),1);self.assertIn('FOREIGN_DESCRIPTOR_WRITER',str(errors[0]))

    def test_actual_host_process_is_not_a_role_string_or_foreign_namespace(self):
        credentials=(os.getpid(),os.getuid(),os.getgid())
        self.assertEqual(P.host_peer(credentials,os.getuid())['pid'],os.getpid())
        with self.assertRaisesRegex(ValueError,'HOST_OWNER_REQUIRED'):P.host_peer((os.getpid(),os.getuid()+1,os.getgid()),os.getuid())


class FixedEndpoint(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(Broker,'run_engine',side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')))
        self.root=Path(self.enterContext(tempfile.TemporaryDirectory(prefix='rse-')));self.root.chmod(0o700)
        self.path=self.root/'broker.sock';self.socket=socket.socket(socket.AF_UNIX);self.addCleanup(self.socket.close)
        self.socket.bind(str(self.path));self.path.chmod(0o600)
        self.config={'socket':str(self.path),'uid':os.getuid()}
        self.item={'Config':{'Env':['REVERIE_WORKER_SOCKET=/run/workers/broker.sock']},
                   'Mounts':[{'Type':'bind','RW':False,'Source':str(self.root),'Destination':'/run/workers'}]}

    def test_actual_owned_socket_needs_exact_readonly_bind_not_a_claim(self):
        self.assertEqual(P.socket_mount(self.item,self.config)[0],Path('/run/workers/broker.sock'))
        for field,value in [('RW',True),('Source',str(self.root/'foreign')),('Destination','/run'),('Type','volume')]:
            with self.subTest(field=field):
                item=copy.deepcopy(self.item);item['Mounts'][0][field]=value
                with self.assertRaisesRegex(ValueError,'READONLY_BIND'):P.socket_mount(item,self.config)
        item=copy.deepcopy(self.item);item['Mounts'].append({'Type':'bind','RW':True,'Source':str(self.root),
                                                         'Destination':'/run/workers/nested'})
        with self.assertRaisesRegex(ValueError,'READONLY_BIND'):P.socket_mount(item,self.config)
        item=copy.deepcopy(self.item);item['Config']['Env']*=2
        with self.assertRaisesRegex(ValueError,'SOCKET_ENV'):P.socket_mount(item,self.config)

    def test_socket_metadata_drift_and_absolute_client_deadline_refuse(self):
        self.path.chmod(0o666)
        with self.assertRaisesRegex(ValueError,'SOCKET_CUSTODY'):P.socket_mount(self.item,self.config)
        from reverie.worker_resume_client import take
        reader=Mock();reader.recv.return_value=b'a'
        with patch('reverie.worker_resume_client.time.monotonic',side_effect=[0,3]),self.assertRaises(TimeoutError):
            take(reader,2,2)
        reader.recv.assert_called_once_with(2)

    def test_program_facts_bind_real_readonly_bytes_and_refuse_writable_files(self):
        from reverie.worker_resume_program import file_fact,immutable
        selected=self.root/'public-module.js';selected.write_bytes(b'export const publicFixture=true;\n');selected.chmod(0o444)
        fact=file_fact(selected)
        self.assertEqual(fact,{'sha256':hashlib.sha256(selected.read_bytes()).hexdigest(),
                               'bytes':selected.stat().st_size,'mode':0o444})
        # Read-only facts outside the fixed immutable package cannot authorize
        # a native registration, even though the fact collector can hash them.
        with self.assertRaisesRegex(ValueError,'IMMUTABLE_PROGRAM'):immutable(selected)
        selected.chmod(0o644)
        with self.assertRaisesRegex(ValueError,'READONLY_PROGRAM'):file_fact(selected)

    def test_only_exact_compiled_h_wrapper_and_fixed_resource_variant_are_programs(self):
        from reverie.worker_resume_program import programs,require_programs
        console=Path('/nix/store/'+'0'*32+'-public-console');node='/nix/store/'+'1'*32+'-public-node/bin/node'
        wrapper=str(console/'lib/reverie/scripts/owner-terminal-start.mjs')
        manifest={'console':str(console),'nodeInvocation':node,'programs':programs(console,node),'files':{wrapper:{}}}
        require_programs(manifest)
        self.assertEqual(manifest['programs'][2],[node,wrapper,'web','--host','0.0.0.0','--port','3000'])
        self.assertEqual(manifest['programs'][3],manifest['programs'][2]+['--resource-replacement'])
        for change in ('wrapper','missing','flags'):
            bad=copy.deepcopy(manifest)
            if change=='wrapper':bad['programs'][2][1]=str(console/'scripts/arbitrary.mjs')
            elif change=='missing':bad['files']={}
            else:bad['programs'][3][-1]='--arbitrary'
            with self.assertRaisesRegex(ValueError,'FIXED_WEBSITE_ARGV'):require_programs(bad)


class ProgramAggregateBudget(unittest.TestCase):
    """Real small readonly Nix inputs; no graph can register as a website.

    jq is deliberately not a console: reaching MATCHING_CONSOLE proves the
    complete measured byte budget passed without authorizing unrelated code.
    No mocked file sizes, path custody or hashes and no large allocation.
    """
    def setUp(self):
        import stat
        from reverie import worker_resume_program as Q
        from reverie.website_image_provenance import nix_build_input
        self.Q = Q
        selected = shutil.which('jq')
        self.assertIsNotNone(selected, 'The declared flake jq is required')
        self.console = Path(selected).resolve(strict=True).parent.parent
        self.executable = Path('/proc/self/exe').resolve(strict=True)
        self.console_bytes = sum(p.lstat().st_size for p in self.console.rglob('*')
                                 if stat.S_ISREG(p.lstat().st_mode))
        self.executable_bytes = self.executable.stat().st_size
        self.total = self.console_bytes + self.executable_bytes
        self.validator = lambda path: nix_build_input(path, 256 << 20)

    def collect(self):
        return self.Q.build(self.console, self.executable, input_validator=self.validator)

    def test_exact_measured_console_plus_executable_budget_reaches_identity_guard(self):
        with patch.object(self.Q, 'MAX_BYTES', self.total), \
             self.assertRaisesRegex(ValueError, 'RESUME_MATCHING_CONSOLE_REQUIRED'):
            self.collect()

    def test_one_byte_below_measured_total_refuses_before_identity_guard(self):
        with patch.object(self.Q, 'MAX_BYTES', self.total - 1), \
             self.assertRaisesRegex(ValueError, 'RESUME_PROGRAM_TOTAL'):
            self.collect()

    def test_executable_alone_crosses_otherwise_fitting_console_budget(self):
        with patch.object(self.Q, 'MAX_BYTES', self.console_bytes), \
             self.assertRaisesRegex(ValueError, 'RESUME_PROGRAM_TOTAL'):
            self.collect()
