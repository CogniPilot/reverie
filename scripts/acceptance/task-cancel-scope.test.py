"""Pure outer fault controls. No scope, model, task or native consumer runs."""
import argparse,copy,fcntl,hashlib,importlib.util,json,os,signal,subprocess,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('fixed_cancel_scope',HERE/'task-cancel-scope.py')
outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)
UNIT='reverie-task-cancel-'+'a'*32+'.scope'
PROPS={'Id':UNIT,'InvocationID':'b'*32,'ControlGroup':'/user.slice/'+UNIT,'ActiveState':'active',
       'RuntimeMaxUSec':'2min','TimeoutStopUSec':'30s','MemoryMax':str(outer.MEMORY),'MemorySwapMax':'0','TasksMax':'128'}
PASS={'settled':True,'forcedStop':False,'failures':[],'inner':{'result':{'state':'PASS_OWN_CANONICAL_CANCEL_COMPONENT'},'survivors':[]}}
class Controls(unittest.TestCase):
    def test_cpu_choice_is_private_validated_and_has_no_host_fallback(self):
        self.assertEqual(outer.cpu_set([0,3]),[0,3])
        for value in(None,[],[True],[1,1],[-1],[1.0],list(range(9)),'0,3'):
            with self.subTest(value=value),self.assertRaisesRegex(RuntimeError,'CPU list'):outer.cpu_set(value)
    def test_actual_lifetime_and_resource_properties_are_mandatory(self):
        value=outer.capture_scope(PROPS,UNIT);self.assertEqual(value['invocationId'],'b'*32)
        for key,v in [('InvocationID',''),('RuntimeMaxUSec','infinity'),('TimeoutStopUSec','90s'),('MemorySwapMax','1'),('MemoryMax','max'),('TasksMax','129')]:
            with self.subTest(key=key),self.assertRaises(RuntimeError):outer.capture_scope({**PROPS,key:v},UNIT)
    def test_inactive_gc_requires_previous_exact_active_binding(self):
        binding=outer.capture_scope(PROPS,UNIT)
        self.assertTrue(outer.terminal_scope({'Id':UNIT,'LoadState':'not-found','ActiveState':'inactive','InvocationID':'','ControlGroup':''},binding))
        self.assertFalse(outer.terminal_scope({**PROPS,'ActiveState':'failed','InvocationID':'c'*32},binding))
    def test_query_uses_remaining_budget_and_clean_bus_environment(self):
        with patch.dict(outer.os.environ,{'HOME':'/owned','SYSTEMD_HOST':'forbidden','PRIVATE_SECRET':'forbidden'},clear=True),patch.object(outer.time,'monotonic',return_value=9),patch.object(outer.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'Id=owned\n',''))as call:
            outer.query({'systemctl':'/fixed/systemctl'},UNIT,10)
            self.assertEqual(call.call_args.kwargs['timeout'],1)
            self.assertNotIn('SYSTEMD_HOST',call.call_args.kwargs['env']);self.assertNotIn('PRIVATE_SECRET',call.call_args.kwargs['env'])
        with patch.object(outer.time,'monotonic',return_value=10),patch.object(outer.subprocess,'run')as call:
            with self.assertRaises(RuntimeError):outer.query({'systemctl':'never'},UNIT,10)
            call.assert_not_called()
    def test_rebound_scope_cannot_receive_stop(self):
        binding=outer.capture_scope(PROPS,UNIT)
        with patch.object(outer,'query',return_value=(0,{**PROPS,'InvocationID':'c'*32})),patch.object(outer.subprocess,'run')as call:
            with self.assertRaisesRegex(RuntimeError,'changed'):outer.stop_owned_scope({'systemctl':'never'},UNIT,binding,100)
            call.assert_not_called()
    def test_stop_wait_is_capped_by_same_absolute_deadline(self):
        with patch.object(outer,'query',return_value=(0,PROPS)),patch.object(outer.time,'monotonic',return_value=9),patch.object(outer.subprocess,'run')as call:
            outer.stop_owned_scope({'systemctl':'fixed'},UNIT,outer.capture_scope(PROPS,UNIT),10)
            self.assertEqual(call.call_args.kwargs['timeout'],1)
    def test_original_late_signal_wait_pattern_cannot_add_a_stop_after_budget(self):
        clock=[171.0];calls=[]
        def command(argv,**kwargs):
            calls.append((argv,kwargs['timeout']));clock[0]+=kwargs['timeout']
            return subprocess.CompletedProcess(argv,0,''.join(k+'='+v+'\n'for k,v in PROPS.items()),'')
        with tempfile.TemporaryDirectory()as tmp,patch.object(outer.time,'monotonic',side_effect=lambda:clock[0]),patch.object(outer.time,'sleep',side_effect=lambda n:clock.__setitem__(0,clock[0]+n)),patch.object(outer.subprocess,'run',side_effect=command),patch.object(outer,'inner_observation',return_value={'result':None,'known':[],'survivors':[]}):
            value=outer.observe(Path(tmp),'pin',{'systemctl':'never'},UNIT,SimpleNamespace(poll=lambda:None),{'signal':15},172)
        self.assertEqual(clock[0],172);self.assertEqual(len(calls),1);self.assertEqual(calls[0][1],1);self.assertFalse(value['settled'])
    def test_normal_observation_needs_actual_cgroup_empty_and_no_known_survivors(self):
        last={**PROPS,'ActiveState':'inactive','ControlGroup':'','Result':'success'}
        with tempfile.TemporaryDirectory()as tmp,patch.object(outer,'query',side_effect=[(0,PROPS),(0,last)]),patch.object(outer,'inner_observation',return_value=PASS['inner']),patch.object(outer,'cgroup_empty',return_value=True),patch.object(outer.time,'sleep'),patch.object(outer.time,'monotonic',return_value=0):
            value=outer.observe(Path(tmp),'pin',{},UNIT,SimpleNamespace(poll=lambda:0),{'signal':None},10)
        self.assertTrue(value['settled']);self.assertFalse(value['forcedStop']);self.assertTrue(outer.accepted(value,{'known':True},0,[],None))
    def test_durable_result_exit_and_natural_settlement_are_all_required(self):
        self.assertTrue(outer.accepted(PASS,{'known':True},0,[],None))
        for change in ({'settled':False},{'forcedStop':True},{'failures':[{'class':'unknown'}]},{'inner':{'result':None}},{'inner':{'result':{'state':'PASS_OWN_CANONICAL_CANCEL_COMPONENT'},'survivors':[{'pid':1}]}}):
            self.assertFalse(outer.accepted({**PASS,**change},{'known':True},0,[],None))
        self.assertFalse(outer.accepted(PASS,{'known':True},1,[],None)) # visible PASS bytes with failed fsync/inner exit cannot pass
        self.assertFalse(outer.accepted(PASS,{'known':True,'signaled':True},0,[],None))
        self.assertFalse(outer.accepted(PASS,{'known':True},0,[],15))
    def test_missing_durable_result_is_honestly_missing(self):
        with tempfile.TemporaryDirectory()as tmp:
            task=Path(tmp);root=task/('cancel-fixture-'+'a'*32);root.mkdir(mode=0o700)
            outer.exclusive(task/'TASK-CANCEL-ATTEMPT.json',{'pinsSHA256':'pin','root':str(root)})
            value=outer.inner_observation(task,'pin');self.assertIsNone(value['result']);self.assertIsNone(value['resultSHA256'])
    def test_live_captured_pid_is_not_zero_survivors(self):
        with tempfile.TemporaryDirectory()as tmp:
            task=Path(tmp);root=task/('cancel-fixture-'+'a'*32);root.mkdir(mode=0o700)
            outer.exclusive(task/'TASK-CANCEL-ATTEMPT.json',{'pinsSHA256':'pin','root':str(root)})
            outer.exclusive(root/'AUTHORITY-PID.json',outer.process(os.getpid()))
            self.assertEqual(len(outer.inner_observation(task,'pin')['survivors']),1)
    def test_partial_receipt_cannot_choose_an_arbitrary_root(self):
        with tempfile.TemporaryDirectory()as tmp:
            task=Path(tmp);outer.exclusive(task/'TASK-CANCEL-ATTEMPT.json',{'pinsSHA256':'pin','root':'/unrelated'})
            with self.assertRaisesRegex(RuntimeError,'root differs'):outer.inner_observation(task,'pin')
    def test_missing_client_binding_never_signals(self):
        with patch.object(outer.signal,'pidfd_send_signal')as send:
            with self.assertRaisesRegex(RuntimeError,'identity lost'):outer.settle_client(SimpleNamespace(poll=lambda:None),None,None,100)
            send.assert_not_called()
    def test_client_cleanup_shares_absolute_budget(self):
        clock=[8.0];waits=[]
        def wait(timeout):waits.append(timeout);clock[0]+=timeout;raise subprocess.TimeoutExpired('own',timeout)
        child=SimpleNamespace(pid=123456,poll=lambda:None,wait=wait)
        with patch.object(outer,'live',return_value=True),patch.object(outer.time,'monotonic',side_effect=lambda:clock[0]),patch.object(outer.signal,'pidfd_send_signal')as send:
            with self.assertRaisesRegex(RuntimeError,'deadline exhausted'):outer.settle_client(child,{'pid':123456,'startTick':'1'},42,10)
        self.assertEqual(waits,[2]);self.assertEqual(clock[0],10);self.assertEqual([c.args[1]for c in send.call_args_list],[signal.SIGTERM,signal.SIGKILL])
    def test_only_own_held_operation_fd_is_made_private(self):
        with tempfile.TemporaryDirectory()as tmp:
            path=Path(tmp)/'operation.lock';fd=os.open(path,os.O_RDWR|os.O_CREAT,0o644)
            try:
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);self.assertEqual(outer.held_operation_fd(path),fd);self.assertEqual(path.stat().st_mode&0o777,0o600)
            finally:os.close(fd)
    def test_pending_operation_input_refuses_before_any_native_port(self):
        with tempfile.TemporaryDirectory()as tmp:
            path=Path(tmp)/'pins.json';outer.exclusive(path,{'operationId':None});raw=path.read_bytes()
            args=argparse.Namespace(run_owned_fixture=True,pins=str(path),pins_sha256=hashlib.sha256(raw).hexdigest(),lease_root=tmp)
            with patch.object(outer,'query')as query,self.assertRaisesRegex(RuntimeError,'operation ID'):outer.validate(args)
            query.assert_not_called()
    def test_outer_signal_records_request_and_restores_handler(self):
        old=signal.getsignal(signal.SIGTERM)
        with outer.requested_stop()as state:signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None);self.assertEqual(state['signal'],signal.SIGTERM)
        self.assertEqual(signal.getsignal(signal.SIGTERM),old)
    def test_broken_inner_receipt_does_not_suppress_exact_owned_scope_cleanup(self):
        last={**PROPS,'ActiveState':'inactive','ControlGroup':'','Result':'success'}
        inner={'result':None,'known':[],'survivors':[]}
        with tempfile.TemporaryDirectory()as tmp,patch.object(outer,'query',side_effect=[(0,PROPS),(0,last)]),patch.object(outer,'inner_observation',side_effect=[RuntimeError('bad receipt'),inner]),patch.object(outer,'cgroup_empty',return_value=True),patch.object(outer,'stop_owned_scope')as stop,patch.object(outer.time,'sleep'),patch.object(outer.time,'monotonic',return_value=0):
            value=outer.observe(Path(tmp),'pin',{},UNIT,SimpleNamespace(poll=lambda:0),{'signal':None},10)
        stop.assert_called_once();self.assertTrue(value['settled']);self.assertTrue(value['forcedStop']);self.assertFalse(outer.accepted(value,{'known':True},0,[],None))
if __name__=='__main__':unittest.main()
