"""Pure fault controls. No tmux, systemd, provider or native fixture is launched."""
import importlib.util,json,signal,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
life=module('life','stale-busy-lifecycle.py');run=module('inner','stale-busy-run.py');scope=module('outer','stale-busy-scope.py');run.LIFE=life
POLICY={'runtimeSeconds':360,'stopSeconds':60,'memoryMaxBytes':536870912,'pidsMax':128,'activeSeconds':1,'logMaxBytes':1048576,'terminateSeconds':1,'killSeconds':1}
UNIT='reverie-sb-0123456789abcdef.scope'
PROPS={'Id':UNIT,'InvocationID':'a'*32,'ControlGroup':'/user.slice/'+UNIT,'ActiveState':'active','RuntimeMaxUSec':'6min','TimeoutStopUSec':'1min','MemoryMax':'536870912','MemorySwapMax':'0','TasksMax':'128'}
class FakeChild:
    pid=987654321
    returncode=0
    def poll(self):return self.returncode
class Controls(unittest.TestCase):
    def test_actual_probe_units_and_required_boundaries(self):
        self.assertEqual(life.seconds('2s'),2);self.assertEqual(life.seconds('1s'),1)
        binding=life.validate_scope(PROPS,UNIT,POLICY,PROPS['ControlGroup']);self.assertEqual(binding['invocationId'],'a'*32)
        for key,value in [('RuntimeMaxUSec','infinity'),('TimeoutStopUSec','0'),('MemorySwapMax','1'),('TasksMax','129'),('InvocationID',''),('ControlGroup','/other.scope')]:
            with self.subTest(key=key),self.assertRaises(RuntimeError):life.validate_scope({**PROPS,key:value},UNIT,POLICY)
    def test_same_unit_name_is_not_same_invocation(self):
        bound=life.validate_scope(PROPS,UNIT,POLICY)
        self.assertFalse(scope.same_scope({**PROPS,'InvocationID':'b'*32},bound))
        self.assertFalse(scope.terminal_scope({**PROPS,'ActiveState':'inactive','InvocationID':'b'*32},bound))
        self.assertTrue(scope.terminal_scope({'Id':UNIT,'ActiveState':'inactive','LoadState':'not-found','ControlGroup':'','InvocationID':''},bound))
    def test_missing_owner_never_queries_or_signals_mux(self):
        with tempfile.TemporaryDirectory()as tmp,patch.object(life.subprocess,'run')as action:
            with self.assertRaisesRegex(RuntimeError,'missing mux'):life.settle_mux(Path(tmp),'a'*16,{'tmux':'never'}, {})
            action.assert_not_called()
    def test_rebound_mux_never_signals(self):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp);(root/'MUX-OWNER.json').write_text(json.dumps({'pid':1234,'startTick':'1','exe':'never'}));(root/'FIXTURE-IDENTITY.json').write_text(json.dumps({'socket':'sb-'+'a'*16,'muxName':'reverie-12345678'}))
            with patch.object(life,'same',return_value=False),patch.object(life.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'9999',''))as action,patch.object(life.os,'pidfd_open')as pidfd:
                with self.assertRaisesRegex(RuntimeError,'unrecorded'):life.settle_mux(root,'a'*16,{'tmux':'never'}, {})
                self.assertEqual(action.call_count,1);self.assertEqual(action.call_args.args[0][-3:],['display-message','-p','#{pid}']);pidfd.assert_not_called()
    def test_cleanup_attempts_mux_even_when_node_cleanup_raises(self):
        with patch.object(life,'settle_node',side_effect=InterruptedError('signal')),patch.object(life,'settle_mux',return_value={'known':True})as mux:
            result=life.cleanup(None,None,None,None,None,None,POLICY)
            self.assertFalse(result['known']);mux.assert_called_once()
    def test_cleanup_attempts_node_even_when_mux_unknown(self):
        with patch.object(life,'settle_node',return_value={'known':True})as node,patch.object(life,'settle_mux',side_effect=RuntimeError('missing owner')):
            result=life.cleanup(None,None,None,None,None,None,POLICY)
            self.assertFalse(result['known']);node.assert_called_once()
    def supervise_case(self,kind):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp);child=FakeChild();calls=[]
            if kind=='normal':(root/'TERMINAL.json').write_text(json.dumps({'terminal':'COLLECTED','survivors':[]}))
            with patch.object(run.subprocess,'Popen',side_effect=RuntimeError('startup')if kind=='startup'else None,return_value=child),patch.object(life,'proc',return_value={'pid':child.pid,'startTick':'5'}),patch.object(life,'settle_node',side_effect=lambda *_,**kw:calls.append('node')or{'known':True}),patch.object(life,'settle_mux',side_effect=lambda *_,**kw:calls.append('mux')or{'known':True}):
                if kind=='signal':child.poll=lambda:(_ for _ in()).throw(InterruptedError('signal'))
                if kind=='timeout':child.returncode=None;child.poll=lambda:None
                ticks=iter([0,0,2])
                with patch.object(run.time,'monotonic',side_effect=lambda:next(ticks)):
                    result=run.supervise(root,'a'*16,{}, {},['never'],POLICY)
            self.assertEqual(calls,['node','mux'])
            self.assertEqual(result['state'],'PASS_OWN_NON_WORKER_SUBCASES'if kind=='normal'else'FAIL_SETTLED')
            if kind=='timeout':self.assertTrue(result['timedOut'])
    def test_normal_finally(self):self.supervise_case('normal')
    def test_partial_startup_finally(self):self.supervise_case('startup')
    def test_signal_finally(self):self.supervise_case('signal')
    def test_timeout_finally(self):self.supervise_case('timeout')
    def test_pending_signal_handler_records_without_exiting_settlement(self):
        with scope.requested_stop()as state:
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None)
            self.assertEqual(state['signal'],signal.SIGTERM)
    def test_live_scope_cgroup_is_not_settled(self):
        with tempfile.TemporaryDirectory()as tmp:
            # No native cgroup touched: only the fixed read port is injected.
            with patch.object(scope.Path,'read_text',return_value='populated 1\nfrozen 0\n'):
                self.assertFalse(scope.cgroup_empty('/owned-fixture'))
    def test_runtime_bound_is_present_independently_of_inner_cleanup(self):
        text=(HERE/'stale-busy-scope.py').read_text()
        for required in ('--property=RuntimeMaxSec=','--property=TimeoutStopSec=','SCOPE-ATTEMPT.json','cleanup_unknown','with manager.lease.hold'):
            self.assertIn(required,text)
        self.assertNotIn("--collect",text)
    def test_scope_observer_continues_after_query_failure_and_settles(self):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp);bound=life.validate_scope(PROPS,UNIT,POLICY)
            end={**PROPS,'ActiveState':'inactive','Result':'success','ControlGroup':''}
            queries=[(0,PROPS),RuntimeError('transient read'),(0,end)]
            def query(*_):
                value=queries.pop(0)
                if isinstance(value,Exception):raise value
                return value
            with patch.object(run,'query_scope',side_effect=query),patch.object(scope,'recorded',return_value=[]),patch.object(scope,'cgroup_empty',return_value=True),patch.object(scope.time,'sleep'),patch.object(scope.time,'monotonic',return_value=0),patch.object(scope.subprocess,'run')as stop:
                result=scope.observe_scope(run,life,root,root,{'systemctl':'never'},POLICY,UNIT,{},None,{'signal':None},10)
                self.assertTrue(result['settled']);self.assertEqual(result['binding'],bound);self.assertEqual(len(result['failures']),1);stop.assert_not_called()
    def test_scope_rebind_never_stops_and_never_reports_settled(self):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp);queries=iter([(0,PROPS),(0,{**PROPS,'InvocationID':'b'*32})]);clock=[0]
            def query(*_):
                value=next(queries)
                if value[1]['InvocationID']!='a'*32:clock[0]=11
                return value
            with patch.object(run,'query_scope',side_effect=query),patch.object(scope,'recorded',return_value=[]),patch.object(scope.time,'sleep'),patch.object(scope.time,'monotonic',side_effect=lambda:clock[0]),patch.object(scope.subprocess,'run')as stop:
                result=scope.observe_scope(run,life,root,root,{'systemctl':'never'},POLICY,UNIT,{},None,{'signal':None},10)
                self.assertFalse(result['settled']);self.assertTrue(result['failures']);stop.assert_not_called()
    def test_scope_signal_stops_only_same_captured_invocation(self):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp);end={**PROPS,'ActiveState':'failed','Result':'timeout','ControlGroup':''}
            queries=iter([(0,PROPS),(0,PROPS),(0,end)])
            with patch.object(run,'query_scope',side_effect=lambda *_:next(queries)),patch.object(scope,'recorded',return_value=[]),patch.object(scope,'cgroup_empty',return_value=True),patch.object(scope.time,'sleep'),patch.object(scope.time,'monotonic',return_value=0),patch.object(scope.subprocess,'run')as stop:
                result=scope.observe_scope(run,life,root,root,{'systemctl':'immutable-systemctl'},POLICY,UNIT,{},None,{'signal':15},10)
                self.assertTrue(result['settled']);stop.assert_called_once();self.assertEqual(stop.call_args.args[0],['immutable-systemctl','--user','stop',UNIT])
    def test_late_signal_never_starts_an_unbudgeted_stop_wait(self):
        clock=[419.0];calls=[]
        def query(*_):clock[0]+=5;return 0,PROPS
        def stop(*_,**kw):calls.append(kw['timeout']);clock[0]+=kw['timeout']
        with tempfile.TemporaryDirectory()as tmp,patch.object(run,'query_scope',new=query),patch.object(scope,'recorded',return_value=[]),patch.object(scope.time,'monotonic',new=lambda:clock[0]),patch.object(scope.time,'sleep',new=lambda n:clock.__setitem__(0,clock[0]+n)),patch.object(scope.subprocess,'run',new=stop):
            result=scope.observe_scope(run,life,Path(tmp),Path(tmp),{'systemctl':'never'},POLICY,UNIT,{},None,{'signal':15},420)
        self.assertLessEqual(clock[0],480);self.assertFalse(result['settled']);self.assertEqual(calls,[])
    def test_scope_queries_use_remaining_absolute_time_and_refuse_expired(self):
        with patch.object(life.time,'monotonic',return_value=9),patch.object(run.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'Id=fixture\n',''))as query:
            run.query_scope('never',UNIT,10);self.assertEqual(query.call_args.kwargs['timeout'],1)
        with patch.object(life.time,'monotonic',return_value=10),patch.object(run.subprocess,'run')as query:
            with self.assertRaisesRegex(RuntimeError,'deadline exhausted'):run.query_scope('never',UNIT,10)
            query.assert_not_called()
    def test_node_cleanup_cannot_add_kill_wait_after_shared_deadline(self):
        clock=[8.0];child=FakeChild();child.returncode=None;waits=[]
        def wait(timeout):waits.append(timeout);clock[0]+=timeout;raise subprocess.TimeoutExpired('owned',timeout)
        child.wait=wait
        with patch.object(life.time,'monotonic',new=lambda:clock[0]),patch.object(life,'same',return_value=True),patch.object(life.os,'getpgid',return_value=child.pid),patch.object(life.os,'killpg')as signals:
            with self.assertRaisesRegex(RuntimeError,'deadline exhausted'):life.settle_node(child,{'pid':child.pid,'startTick':'1'},dict(POLICY,terminateSeconds=45,killSeconds=5),deadline=10)
        self.assertEqual(waits,[2]);self.assertEqual(clock[0],10);self.assertEqual([c.args[1]for c in signals.call_args_list],[15,9])
    def test_mux_cleanup_probe_wait_uses_same_absolute_deadline(self):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp);(root/'MUX-OWNER.json').write_text(json.dumps({'pid':1234,'startTick':'1','exe':'never'}));(root/'FIXTURE-IDENTITY.json').write_text(json.dumps({'socket':'sb-'+'a'*16,'muxName':'reverie-12345678'}))
            with patch.object(life.time,'monotonic',return_value=8),patch.object(life,'same',return_value=False),patch.object(life.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'',''))as query:
                value=life.settle_mux(root,'a'*16,{'tmux':'never'},{},deadline=10)
                self.assertTrue(value['known']);self.assertEqual(query.call_args.kwargs['timeout'],2)
    def test_both_cleanup_targets_share_one_budget_when_first_consumes_it(self):
        clock=[8.0];seen=[]
        def node(*_,deadline):seen.append(deadline);clock[0]+=life.wait_timeout(deadline,50);return {'known':True}
        def mux(*_,deadline):seen.append(deadline);life.wait_timeout(deadline,5);raise AssertionError('expired wait was permitted')
        with patch.object(life.time,'monotonic',new=lambda:clock[0]),patch.object(life,'settle_node',new=node),patch.object(life,'settle_mux',new=mux):
            value=life.cleanup(None,None,None,None,None,None,POLICY,deadline=10)
        self.assertEqual(seen,[10,10]);self.assertEqual(clock[0],10);self.assertFalse(value['known']);self.assertIn('deadline exhausted',value['mux']['reason'])
if __name__=='__main__':unittest.main()
