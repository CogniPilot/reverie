"""Inert source boundary controls; never launch the native cancellation fixture."""
import importlib.util
import json
import ast
import fcntl
import hashlib
import os
import sys
import time
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

HERE=Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

native=load('task-cancel-native');program=load('task-cancel-program')

class SourceBoundaries(unittest.TestCase):
    def test_imports_are_inert_and_private_root_requires_physical_owned_directory(self):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp).resolve();root.chmod(0o700)
            self.assertEqual(program.private_root(str(root)),root)
            alias=root/'alias';alias.symlink_to(root)
            with self.assertRaises(ValueError):program.private_root(str(alias))
            root.chmod(0o755)
            with self.assertRaises(ValueError):program.private_root(str(root))
    def reader(self):
        reader=native.AuthorityBridge.__new__(native.AuthorityBridge)
        reader.deadline=10;reader.pending=bytearray();reader.selector=SimpleNamespace(select=lambda _:True)
        reader.child=SimpleNamespace(stdout=SimpleNamespace(fileno=lambda:123456))
        return reader
    def test_canonical_reply_rejects_eof_and_oversized_frame(self):
        for chunk,reason in [(b'','EOF'),(b'x'*65537,'frame bound')]:
            reader=self.reader()
            with patch.object(native.time,'monotonic',return_value=0),patch.object(native.os,'read',return_value=chunk),self.assertRaisesRegex(RuntimeError,reason):reader.receive()
    def test_expired_reply_budget_does_not_read_or_claim_success(self):
        reader=self.reader()
        with patch.object(native.time,'monotonic',return_value=10),patch.object(native.os,'read')as read,self.assertRaisesRegex(RuntimeError,'deadline'):reader.receive()
        read.assert_not_called()
    def test_framing_keeps_next_complete_canonical_response(self):
        reader=self.reader();reader.pending.extend(b'{"ok":true,"message":{"id":"synthetic"}}\n{"ok":true}\n')
        first=reader.receive();self.assertEqual(first['message']['id'],'synthetic');self.assertEqual(reader.receive(),{'ok':True})
    def test_pid_start_binding_refuses_reuse_even_with_equal_numeric_pid(self):
        with patch.object(native,'identity',return_value={'pid':123,'startTick':'2','state':'S'}):self.assertFalse(native.live({'pid':123,'startTick':'1'}))

class OuterGuardBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name).resolve();root.chmod(0o700)
        self.task=root/'tasks/fixture';self.task.mkdir(mode=0o700,parents=True)
        self.ops=self.task.parent/'.ops';self.ops.mkdir(mode=0o700)
        self.operation=self.ops/'fixture.lock';self.fd=os.open(self.operation,os.O_RDWR|os.O_CREAT,0o600)
        fcntl.flock(self.fd,fcntl.LOCK_EX);self.addCleanup(os.close,self.fd)
        self.here=root/'scripts';self.here.mkdir();self.entry=self.here/'task-cancel-scope.py';self.entry.write_text('pass\n')
        self.proc=root/'proc';self.proc.mkdir();self.pid=12345;process=self.proc/str(self.pid);process.mkdir()
        (process/'fd').mkdir();(process/'fd'/str(self.fd)).symlink_to(self.operation)
        core=Path(sys.executable).resolve();(process/'exe').symlink_to(core)
        fields=['S']+['0']*19;fields[19]='77';(process/'stat').write_text(str(self.pid)+' (fixture) '+' '.join(fields))
        (process/'cmdline').write_bytes(b'\0'.join([str(core).encode(),b'-I',b'-B',str(self.entry).encode()])+b'\0')
        (process/'cgroup').write_text('0::/user.slice/outside-controller.scope\n')
        self.scope={'unit':'reverie-task-cancel-'+'a'*32+'.scope','controlGroup':'/user.slice/native-fixture.scope'}
        self.pins={'operationId':'a'*32,'tools':{'python':str(core)},'toolSHA256':{'python':native.sha(core)},'outerScripts':{'task-cancel-scope.py':native.sha(self.entry),'task-cancel-scope.test.py':'1'*64,'task-cancel-source.test.py':'2'*64}}
        self.attempt={'kind':'OWNED_TASK_CANCEL_SCOPE','operationId':'a'*32,'unit':self.scope['unit'],'pinsSHA256':'b'*64,'outerPID':{'pid':self.pid,'startTick':'77'},'controller':{'exe':str(core),'entry':str(self.entry),'entrySHA256':native.sha(self.entry),'operationLockFD':self.fd},'at':time.time()}
        self.args=SimpleNamespace(pins_sha256='b'*64,outer_attempt_sha256='')
        self.metadata={'id':'fixture','status':'running','scopeUnit':self.scope['unit'],'scopeAttemptSHA256':''}
        self.rewrite()
        for key,value in [('PROC',self.proc),('HERE',self.here)]:
            changed=patch.object(native,key,value);changed.start();self.addCleanup(changed.stop)
    def rewrite(self):
        raw=json.dumps(self.attempt).encode();self.args.outer_attempt_sha256=hashlib.sha256(raw).hexdigest()
        self.metadata['scopeAttemptSHA256']=self.args.outer_attempt_sha256
        for name,data in [('SCOPE-ATTEMPT.json',raw),('.reverie-task.json',json.dumps(self.metadata).encode())]:
            path=self.task/name;path.write_bytes(data);path.chmod(0o600)
    def verify(self):return native.verify_outer(self.args,self.pins,self.task,self.scope)
    def test_exact_outside_controller_source_descriptor_and_busy_lock_qualify(self):
        self.assertEqual(self.verify(),self.metadata)
        other=os.open(self.operation,os.O_RDONLY)
        try:
            with self.assertRaises(BlockingIOError):fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally:os.close(other)
    def test_released_operation_is_not_reacquired_as_authority(self):
        fcntl.flock(self.fd,fcntl.LOCK_UN)
        with self.assertRaisesRegex(RuntimeError,'retain canonical operation lock'):self.verify()
    def test_unknown_or_stale_outer_record_and_metadata_refuse(self):
        self.attempt['unexpected']=True;self.rewrite()
        with self.assertRaisesRegex(RuntimeError,'closed outer attempt'):self.verify()
        del self.attempt['unexpected'];self.attempt['at']=time.time()-181;self.rewrite()
        with self.assertRaisesRegex(RuntimeError,'expired'):self.verify()
        self.attempt['at']=time.time();self.metadata['status']='allocated';self.rewrite()
        with self.assertRaisesRegex(RuntimeError,'running metadata'):self.verify()
    def test_controller_inside_native_scope_cannot_qualify_as_outer(self):
        (self.proc/str(self.pid)/'cgroup').write_text('0::'+self.scope['controlGroup']+'\n')
        with self.assertRaisesRegex(RuntimeError,'outside native scope'):self.verify()
    def test_claimed_controller_entry_or_actual_prefix_drift_refuses(self):
        process=self.proc/str(self.pid);saved=(process/'cmdline').read_bytes()
        (process/'cmdline').write_bytes(b'not-the-fixed-controller\0')
        with self.assertRaisesRegex(RuntimeError,'entry prefix'):self.verify()
        (process/'cmdline').write_bytes(saved);self.entry.write_text('changed\n')
        with self.assertRaisesRegex(RuntimeError,'source differs'):self.verify()
    def test_actual_operation_descriptor_cannot_point_at_another_inode(self):
        other=self.ops/'other.lock';other.write_text('');link=self.proc/str(self.pid)/'fd'/str(self.fd);link.unlink();link.symlink_to(other)
        with self.assertRaisesRegex(RuntimeError,'descriptor differs'):self.verify()
    def test_pid_reuse_during_guard_io_refuses(self):
        first={'pid':self.pid,'startTick':'77','state':'S'};second={**first,'startTick':'78'}
        with patch.object(native,'identity',side_effect=[first,second]),self.assertRaisesRegex(RuntimeError,'binding changed'):self.verify()
    def test_result_parent_fsync_failure_cannot_set_durable_completion(self):
        tree=ast.parse((HERE/'task-cancel-native.py').read_text())
        main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main')
        final=next(n.finalbody for n in ast.walk(main)if isinstance(n,ast.Try)and n.finalbody and any(isinstance(x,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='durable_result'for t in x.targets)for x in n.finalbody))
        nodes=final[-2:];self.assertIsInstance(nodes[-1],ast.Assign)
        code=compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),'actual-result-finalizer','exec')
        namespace={'root':self.task,'result':{'state':'PASS_OWN_CANONICAL_CANCEL_COMPONENT'},'exclusive':native.exclusive,'durable_result':False}
        with patch.object(native.os,'fsync',side_effect=[None,OSError('owned parent fsync fault')]),self.assertRaises(OSError):exec(code,namespace)
        self.assertFalse(namespace['durable_result'])
        self.assertFalse(any(isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and isinstance(n.func.value,ast.Name)and n.func.value.id=='workspace'for n in ast.walk(main)))

class PortableCpuBoundaries(unittest.TestCase):
    def test_other_host_cpu_selection_is_explicit_and_actual_affinity_must_fit(self):
        self.assertEqual(native.validate_cpu_set([0,1]),(0,1))
        with patch.object(native.os,'sched_getaffinity',return_value={0,1}):self.assertEqual(native.require_cpu_affinity([0,1]),(0,1))
        with patch.object(native.os,'sched_getaffinity',return_value={0,1,2}),self.assertRaisesRegex(RuntimeError,'CPU binding'):native.require_cpu_affinity([0,1])
    def test_private_cpu_schema_has_no_boolean_duplicate_or_missing_fallback(self):
        for value in (None,(),[],[True],[False,1],[-1],[0,0],list(range(9)),['0'],[1.0],[float('inf')]):
            with self.subTest(value=value),self.assertRaisesRegex(RuntimeError,'CPU list'):native.validate_cpu_set(value)
    def test_validation_preserves_private_input_and_rejects_before_kernel_read(self):
        value=[3,1];self.assertEqual(native.validate_cpu_set(value),(3,1));self.assertEqual(value,[3,1])
        with patch.object(native.os,'sched_getaffinity')as observation,self.assertRaises(RuntimeError):native.require_cpu_affinity(None)
        observation.assert_not_called()

if __name__=='__main__':unittest.main()
