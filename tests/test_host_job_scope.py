"""Fixed native observer fault controls. Kernel/tool ports controlled; no scope/process runs."""
from dataclasses import replace
from contextlib import ExitStack
import copy,os,subprocess,unittest
from unittest.mock import patch
from reverie import host_job_scope as h

SPEC=h.FixedHostJobSpec('a'*32,'fixed-public-browser','c'*64,'reverie-gpu-job-'+'a'*32+'.scope',6*1024**3,256,(0,1),1380,30,'/nix/store/fixed/bin/systemctl','d'*64,'/nix/store/fixed/bin/node','e'*64,'/nix/store/fixed/runner.mjs','f'*64,'/owned/job')
GROUP='/user.slice/'+SPEC.unit
ACTIVE={'Id':SPEC.unit,'InvocationID':'b'*32,'LoadState':'loaded','ActiveState':'active','ControlGroup':GROUP,'RuntimeMaxUSec':'23min','TimeoutStopUSec':'30s','MemoryMax':str(SPEC.memory_bytes),'MemorySwapMax':'0','TasksMax':'256'}
TERMINAL={**ACTIVE,'ActiveState':'inactive','ControlGroup':''}
class ScopeControls(unittest.TestCase):
    def fixture(self,query=None,dead=False):
        stack=ExitStack();self.addCleanup(stack.close)
        stack.enter_context(patch.object(h,'_program'))
        stack.enter_context(patch.object(h,'_query',return_value=(0,query or ACTIVE)))
        stack.enter_context(patch.object(h,'_group',return_value=GROUP));stack.enter_context(patch.object(h,'_cpus',return_value={0,1}))
        stack.enter_context(patch.object(h,'_exe',return_value=SPEC.node_exe));stack.enter_context(patch.object(h,'_cwd',return_value=SPEC.working_directory));stack.enter_context(patch.object(h,'_owner',return_value=os.getuid()))
        stack.enter_context(patch.object(h,'_birth',return_value=(h.ProcessBirth(200,'9'),'Z'if dead else'S',os.getpid())))
        def read(path,maximum):
            return {'memory.max':str(SPEC.memory_bytes),'memory.current':'1048576','memory.swap.max':'0','pids.max':'256','pids.current':'1','cgroup.procs':'200\n','cmdline':SPEC.node_exe+'\0'+SPEC.node_entry+'\0'}[path.name]
        stack.enter_context(patch.object(h,'_read',side_effect=read));return stack
    def test_actual_capture_is_registered_noncopyable_and_metadata_is_detached(self):
        self.fixture();observer=h.OwnScopeObserver();b=observer.capture(SPEC);self.assertEqual(b.spec,SPEC)
        m=b.metadata();m['spec']['cpus'].append(2);self.assertEqual(b.spec.cpus,(0,1))
        with self.assertRaises(TypeError):copy.copy(b)
        with self.assertRaises(TypeError):copy.deepcopy(b)
        with self.assertRaises(TypeError):b._group='/other'
        with self.assertRaises(h.ScopeUnknown):h.verify_settled(m)
    def test_missing_native_capture_or_forged_mint_does_not_settle(self):
        with self.assertRaises(h.ScopeUnknown):h.OwnScopeObserver().verify_settled({'settled':True})
        with self.assertRaises(h.ScopeUnknown):h.OwnedScopeBinding(object(),SPEC,'b'*32,GROUP)
    def test_dead_node_cannot_mint_even_when_other_metadata_matches(self):
        self.fixture(dead=True)
        with self.assertRaises(h.ScopeUnknown):h.OwnScopeObserver().capture(SPEC)
    def test_wrong_limits_and_natural_scope_incarnation_are_required(self):
        for change in({'MemoryMax':'1'},{'InvocationID':''},{'ControlGroup':'/foreign'},{'ActiveState':'failed'},{'MemorySwapMax':'1'}):
            with self.subTest(change=change):
                with ExitStack()as s:
                    s.enter_context(patch.object(h,'_program'));s.enter_context(patch.object(h,'_query',return_value=(0,{**ACTIVE,**change})))
                    with self.assertRaises(h.ScopeUnknown):h.OwnScopeObserver().capture(SPEC)
    def test_capture_brackets_kernel_reads_with_exact_native_unit(self):
        self.fixture()
        with patch.object(h,'_query',side_effect=[(0,ACTIVE),(0,{**ACTIVE,'InvocationID':'d'*32})]),self.assertRaises(h.ScopeUnknown):h.OwnScopeObserver().capture(SPEC)
    def bound(self):
        observer=h.OwnScopeObserver();binding=observer.capture(SPEC);client=object.__new__(subprocess.Popen);client._child_created=False;client.pid=200;client.returncode=None;observer.attach_client(binding,client);return observer,binding,client
    def test_client_must_be_actual_direct_live_owned_child(self):
        self.fixture();observer=h.OwnScopeObserver();binding=observer.capture(SPEC)
        with self.assertRaises(h.ScopeUnknown):observer.attach_client(binding,{'pid':200,'returncode':0})
        with self.assertRaises(h.ScopeUnknown):observer.verify_settled(binding)
    def test_terminal_scope_still_requires_reaped_client_and_gone_births(self):
        self.fixture();observer,b,client=self.bound()
        with patch.object(h,'_query',return_value=(0,TERMINAL)),patch.object(h,'_empty',return_value=True):
            with self.assertRaisesRegex(h.ScopeUnknown,'NOT_REAPED'):observer.verify_settled(b)
            client.returncode=0
            with self.assertRaisesRegex(h.ScopeUnknown,'STILL_EXISTS'):observer.verify_settled(b)
    def test_zero_population_alone_cannot_hide_zombie(self):
        self.fixture();observer,b,client=self.bound();client.returncode=0
        with patch.object(h,'_query',return_value=(0,TERMINAL)),patch.object(h,'_empty',return_value=True),patch.object(h,'_birth',return_value=(h.ProcessBirth(200,'9'),'Z',os.getpid())),self.assertRaisesRegex(h.ScopeUnknown,'STILL_EXISTS'):h.verify_settled(b)
    def test_exact_terminal_native_snapshot_and_all_births_gone_produces_typed_settlement(self):
        self.fixture();observer,b,client=self.bound();client.returncode=0
        with patch.object(h,'_query',return_value=(0,TERMINAL)),patch.object(h,'_empty',return_value=True),patch.object(h,'_birth',return_value=None):
            proof=h.verify_settled(b);self.assertIsInstance(proof,h.ScopeSettlement);self.assertEqual(proof.spec,SPEC);self.assertEqual(proof.invocation_id,'b'*32)
    def test_rebound_or_repopulated_unit_never_settles(self):
        self.fixture();observer,b,client=self.bound();client.returncode=0
        with patch.object(h,'_query',return_value=(0,{**TERMINAL,'InvocationID':'d'*32})),patch.object(h,'_empty',return_value=True),self.assertRaises(h.ScopeUnknown):observer.verify_settled(b)
        with patch.object(h,'_query',return_value=(0,TERMINAL)),patch.object(h,'_empty',return_value=False),self.assertRaises(h.ScopeUnknown):observer.verify_settled(b)
    def test_private_cpu_and_policy_schema_has_no_host_fallback(self):
        for change in({'cpus':()},{'cpus':(True,)},{'cpus':(0,0)},{'memory_bytes':True},{'runtime_seconds':0},{'unit':'arbitrary.scope'}):
            with self.subTest(change=change),self.assertRaises(h.ScopeUnknown):replace(SPEC,**change).validate()
    def test_external_deadline_is_finite_and_clamps_both_native_snapshots(self):
        for value in(True,float('nan'),float('inf'),float('-inf')):
            with self.subTest(value=value),self.assertRaises(h.ScopeUnknown):h._deadline(5,value)
        self.fixture()
        with patch.object(h.time,'monotonic',return_value=10),patch.object(h,'_query',return_value=(0,ACTIVE))as query:
            h.OwnScopeObserver().capture(SPEC,deadline=10.25)
            self.assertEqual([c.args[1]for c in query.call_args_list],[10.25,10.25])
            with self.assertRaises(h.ScopeUnknown):h._deadline(5,10)
    def ancestry(self,parent_memory=None,parent_used=None,missing=False):
        from pathlib import Path
        leaf=Path('/sys/fs/cgroup')/GROUP.lstrip('/');parent=leaf.parent
        def read(path,maximum):
            if path.parent==Path('/sys/fs/cgroup'):raise FileNotFoundError('true root has no limit')
            if path.parent==leaf:return {'memory.current':'1048576','pids.current':'1'}[path.name]
            self.assertEqual(path.parent,parent)
            if missing and path.name=='memory.max':raise FileNotFoundError('non-root unknown')
            return {'memory.max':str(SPEC.memory_bytes if parent_memory is None else parent_memory),'memory.current':str(1048576 if parent_used is None else parent_used),'pids.max':'512','pids.current':'10'}[path.name]
        return read
    def test_stricter_finite_ancestor_refuses_before_a_binding_is_minted(self):
        with patch.object(h,'_read',side_effect=self.ancestry(parent_memory=1024**3)),self.assertRaisesRegex(h.ScopeUnknown,'ANCESTOR_CAPACITY'):h._ancestor_capacity(GROUP,SPEC,h.time.monotonic()+2)
    def test_actual_own_scope_charge_is_counted_once_without_sibling_credit(self):
        with patch.object(h,'_read',side_effect=self.ancestry()):h._ancestor_capacity(GROUP,SPEC,h.time.monotonic()+2)
        with patch.object(h,'_read',side_effect=self.ancestry(parent_used=1073741824)),self.assertRaisesRegex(h.ScopeUnknown,'ANCESTOR_CAPACITY'):h._ancestor_capacity(GROUP,SPEC,h.time.monotonic()+2)
    def test_missing_nonroot_controller_facts_are_not_unlimited(self):
        with patch.object(h,'_read',side_effect=self.ancestry(missing=True)),self.assertRaisesRegex(h.ScopeUnknown,'FACTS_UNKNOWN'):h._ancestor_capacity(GROUP,SPEC,h.time.monotonic()+2)
    def test_own_counter_drift_during_ancestor_io_refuses(self):
        read=self.ancestry();counts=[0]
        def changed(path,maximum):
            if path.name=='memory.current'and path.parent.name==SPEC.unit:
                counts[0]+=1
                if counts[0]==2:return '2097152'
            return read(path,maximum)
        with patch.object(h,'_read',side_effect=changed),self.assertRaisesRegex(h.ScopeUnknown,'OWN_CHARGE_CHANGED'):h._ancestor_capacity(GROUP,SPEC,h.time.monotonic()+2)
if __name__=='__main__':unittest.main()
