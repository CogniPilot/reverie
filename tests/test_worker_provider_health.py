"""Actual owned kernel command trees + real metadata; fixed engine/guest-FS ports.

No container/service/provider execution or native installation qualification.
The only FS mapping is the synthetic container's /home/agent to its real owned
home, like existing NativeObserver fixtures; process/birth/namespace joins are real.
"""
import copy,json,os,signal,subprocess,sys,time,unittest,threading,tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from reverie import worker_provider_health as H
from reverie.worker_cleanup import StopBudget
from reverie.worker_resources import policy_digest
from reverie.worker_storage import storage_paths,prepare_storage
from tests import test_worker as F
EID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';SID=F.SID;CID='1'*64


class ProviderHealth(unittest.TestCase):
    def setUp(self):
        F.WorkerTests.setUp(self);self.config['uid']=os.getuid();self.config['gid']=os.getgid()
        self.employee={'id':EID,'owner':'fixture-owner','sessionId':SID,'sessionGeneration':1,'desiredRunning':True,'onVacation':False}
        self.company_path=Path(self.config['companyFile']);self.company();self.paths=storage_paths(self.config,SID);prepare_storage(self.config,self.paths)
        self.runtime=Path(self.config['stateRoot'])/SID/'runtime.json';self.runtime.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        self.exit_name='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.exit';self.runtime.write_text(json.dumps({'exit':self.exit_name}));self.runtime.chmod(0o600)
        self.launch_dir=self.paths.home/'.reverie-launch';self.launch_dir.mkdir(mode=0o700)
        self.path=self.root/'broker.json';self.path.write_text(json.dumps(self.config));self.path.chmod(0o600)
        provider="import time;print('READY',flush=True);time.sleep(60)"
        pane="import subprocess,sys,time,signal;p=subprocess.Popen([sys.executable,'-I','-B','-c',"+repr(provider)+"],stdout=subprocess.PIPE,text=True);assert p.stdout.readline().strip()=='READY';signal.signal(signal.SIGTERM,lambda *_:(p.terminate(),p.wait(timeout=2),sys.exit(0)));print(p.pid,flush=True);time.sleep(60)"
        init="import subprocess,sys,json,time,signal;p=subprocess.Popen([sys.executable,'-I','-B','-c',"+repr(pane)+"],stdout=subprocess.PIPE,text=True);child=int(p.stdout.readline());signal.signal(signal.SIGTERM,lambda *_:(p.terminate(),p.wait(timeout=2),sys.exit(0)));print(json.dumps([p.pid,child]),flush=True);time.sleep(60)"
        self.child=subprocess.Popen([sys.executable,'-I','-B','-c',init],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        self.addCleanup(self.settle);self.pane_pid,self.command_pid=json.loads(self.child.stdout.readline());self.init_pid=self.child.pid
        self.row={'Id':CID,'Name':'/test-agent-'+SID,'Image':self.config['image'],
            'State':{'Running':True,'Pid':self.init_pid,'Paused':False,'Restarting':False,'Dead':False,'StartedAt':'fixture'},
            'Config':{'Labels':{'reverie.worker':'test','reverie.session':SID,'reverie.employee':EID,'reverie.worker-policy':policy_digest(self.config,SID)}},
            'Mounts':[{'Type':'bind','Source':str(self.paths.home),'Destination':'/home/agent','RW':True}]}
        self.calls=[];self.after=None;self.pane_dead=False;self.guest_pid=self.pane_pid;self.omit_command=False
        self.broker=SimpleNamespace(config=self.config,config_file=self.path,stopping=StopBudget(),run_engine=self.engine)
        # Keep the fake clock exact at TTL; a real offset can round five seconds above the inclusive boundary.
        self.clock=0.;self.monotonic=0.;self.observer=H.ProviderHealthObserver(self.broker,
            monotonic=lambda:self.monotonic+self.clock,epoch=lambda:1000+self.clock)
        original=Path.stat;guest=Path('/proc')/str(self.init_pid)/'root/home/agent'
        home=self.paths.home
        def projected(path,*args,**kwargs):return original(home if path==guest else path,*args,**kwargs)
        self.enterContext(patch.object(Path,'stat',projected))

    def company(self):self.company_path.write_text(json.dumps({'employees':[self.employee]}));self.company_path.chmod(0o600)
    def settle(self):
        if self.child.poll()is None:os.killpg(self.child.pid,signal.SIGTERM)
        self.child.communicate(timeout=3)
    def engine(self,args,optional=False,deadline=None):
        self.calls.append(args);self.assertIsNotNone(deadline)
        if args[:2]==['inspect','--format']:
            self.assertEqual(args[2],H.INSPECT);value=json.dumps(self.row)
            if self.after:self.after(args)
            return subprocess.CompletedProcess(args,0,value,'')
        if args[:2]==['top',CID]:
            pids=[self.init_pid,self.pane_pid]+([]if self.omit_command else[self.command_pid])
            return subprocess.CompletedProcess(args,0,'PID PPID\n'+'\n'.join(f"{pid} {H._process_record(pid)['parentPid']}"for pid in pids)+'\n','')
        if args and args[0]=='exec':
            self.assertEqual(args,['exec','--env','LANG=C.UTF-8','--env','LC_ALL=C.UTF-8',CID,'/bin/tmux','-u','-L','reverie-laptop','display-message','-p','-t','office','#{pane_dead}|#{pane_pid}'])
            return subprocess.CompletedProcess(args,0,f'{int(self.pane_dead)}|{self.guest_pid}\n','')
        self.fail('Unexpected or mutating engine command')
    def result(self):
        value=self.observer.read();self.assertEqual(value['purpose'],'worker-provider-health-v1');return value['providers']

    def test_real_live_command_join_is_independent_of_any_viewer_and_never_issues_lifecycle(self):
        result=self.result();self.assertEqual(result[0]['state'],'healthy');self.assertEqual(result[0]['reason'],'LIVE_NATIVE_COMMAND')
        self.assertEqual(result[0]['initPID'],self.init_pid);self.assertTrue(all(c[0]in('inspect','top','exec')for c in self.calls))
        self.assertEqual(self.employee['desiredRunning'],True);self.assertFalse(self.employee['onVacation'])

    def test_exact_stopped_container_is_dead_without_an_init_or_inner_probe(self):
        self.row['State'].update(Running=False,Pid=0,FinishedAt='2026-10-30T00:00:00Z')
        value=self.result()[0]
        self.assertEqual(value['state'],'dead');self.assertEqual(value['reason'],'CONTAINER_STOPPED')
        self.assertEqual(value['proofKind'],'stopped-container');self.assertNotIn('initPID',value)
        self.assertTrue(all(call[0]=='inspect'for call in self.calls))
        self.row['State']['FinishedAt']='0001-01-01T00:00:00Z';self.observer.cache.clear()
        self.assertEqual(self.result()[0]['state'],'unknown')

    def test_guest_number_not_a_host_pid_or_a_different_process_is_not_evidence(self):
        for pid in (1,self.command_pid):
            self.guest_pid=pid;self.observer.cache.clear();result=self.result();self.assertEqual(result[0]['state'],'unknown')

    def test_live_pane_without_a_joined_command_stays_unknown(self):
        self.omit_command=True;self.assertEqual(self.result()[0]['state'],'unknown')

    def test_real_exit_receipt_and_dead_office_are_reported_without_any_stop_or_start(self):
        for completed in (False,True):
            self.observer.cache.clear();self.pane_dead=not completed
            path=self.launch_dir/self.exit_name
            if completed:path.write_text('0');path.chmod(0o600)
            self.assertEqual(self.result()[0]['state'],'dead')
            self.assertFalse(any(c[0]in('stop','start','create','rm','kill')for c in self.calls))

    def test_starting_request_or_publication_temp_is_not_provider_readiness(self):
        for suffix in ('.json','.exit.tmp'):
            path=self.launch_dir/(self.exit_name[:-5]+suffix);path.write_text('fixture');path.chmod(0o600)
            self.assertEqual(self.result()[0]['state'],'unknown');path.unlink()

    def test_cache_retains_original_epoch_and_binding_and_expires_monotonically(self):
        first=self.result()[0];self.clock+=1;self.calls.clear();again=self.result()[0]
        self.assertEqual(again,first);self.assertFalse(any(c[0]=='exec'for c in self.calls))
        for _ in range(4):
            self.clock+=1;self.assertEqual(self.result()[0],first)
        self.clock+=1;self.assertEqual(self.result()[0]['state'],'healthy');self.assertGreater(self.result()[0]['observedAtEpochMs'],first['observedAtEpochMs'])

    def test_late_canonical_drift_refuses_and_does_not_poison_cache(self):
        def after(args):
            if len([c for c in self.calls if c[0]=='inspect'])==2:self.employee['sessionGeneration']=2;self.company()
        self.after=after;self.assertEqual(self.result(),[]);self.assertEqual(self.observer.cache,{})
        self.after=None;self.calls.clear();self.assertEqual(self.result()[0]['state'],'healthy');self.assertTrue(any(c[0]=='top'for c in self.calls))

    def test_wrong_binding_policy_image_and_ambiguous_pane_cannot_report_healthy(self):
        for key,value in [('Image','sha256:'+'2'*64),('Name','/foreign')]:
            before=self.row[key];self.row[key]=value;rows=self.result();self.assertFalse(any(r['state']=='healthy'for r in rows));self.row[key]=before
        self.row['Config']['Labels']['reverie.worker-policy']='0'*64;self.assertEqual(self.result()[0]['state'],'unknown')

    def test_owner_off_vacation_and_migration_never_run_the_inner_probe(self):
        for key,value in [('desiredRunning',False),('onVacation',True),('bindingMigration',{'active':True})]:
            before=copy.deepcopy(self.employee);self.employee[key]=value;self.company();self.calls.clear()
            self.assertEqual(self.result()[0]['state'],'unknown');self.assertEqual(self.calls,[]);self.employee=before;self.company()

    def test_status_budget_exhaustion_returns_unknown_without_caching_positive_or_mutating(self):
        def after(args):self.clock+=H.BUDGET+1
        self.after=after;self.assertEqual(self.result(),[]);self.assertEqual(self.observer.cache,{})

    def test_full_mount_records_allow_permutation_but_refuse_attribute_or_duplicate_drift(self):
        self.row['Mounts'].append({'Type':'bind','Source':str(self.root/'work'),'Destination':'/workspace','RW':False,'Driver':'local','Propagation':'rprivate'})
        original=copy.deepcopy(self.row)
        for change in ('order','field','duplicate'):
            with self.subTest(change=change):
                self.row=copy.deepcopy(original);self.observer.cache.clear();count=0
                def after(args):
                    nonlocal count
                    count+=1
                    if count==1:
                        if change=='order':self.row['Mounts'].reverse()
                        elif change=='field':self.row['Mounts'][1]['Driver']='different'
                        else:self.row['Mounts'].append(copy.deepcopy(self.row['Mounts'][1]))
                self.after=after;result=self.result()
                if change=='order':self.assertEqual(result[0]['state'],'healthy')
                else:self.assertEqual(result,[])

    def test_real_company_fd_close_cannot_bind_old_on_intent_to_a_new_file_stamp(self):
        original=os.close;target=self.company_path.stat();changed=[]
        def close(fd):
            info=os.fstat(fd);original(fd)
            if not changed and (info.st_dev,info.st_ino)==(target.st_dev,target.st_ino):
                changed.append(True);self.employee['desiredRunning']=False;self.company()
        with patch.object(os,'close',close):self.assertEqual(self.result(),[])
        self.assertEqual(changed,[True]);self.assertEqual(self.observer.cache,{})
        self.assertFalse(self.employee['desiredRunning']);self.assertEqual(self.calls,[])

    def test_real_runtime_fd_close_cannot_bind_the_previous_nonce_to_new_metadata(self):
        original=os.close;target=self.runtime.stat();changed=[]
        def close(fd):
            info=os.fstat(fd);original(fd)
            if not changed and (info.st_dev,info.st_ino)==(target.st_dev,target.st_ino):
                changed.append(True);self.runtime.write_text(json.dumps({'exit':'cccccccc-cccc-4ccc-8ccc-cccccccccccc.exit'}))
        with patch.object(os,'close',close):
            self.assertFalse(any(row['state']=='healthy'for row in self.result()))
        self.assertEqual(changed,[True]);self.assertFalse(any(c[0]=='exec'for c in self.calls))

    def test_storage_ready_marker_drift_invalidates_fresh_and_cached_native_proof(self):
        for cached in (False,True):
            with self.subTest(cached=cached):
                marker=self.paths.root/'storage.json'
                marker.write_text(json.dumps({'version':1,'kind':'employee','identity':EID,'state':'ready'}))
                self.observer.cache.clear();self.calls.clear()
                if cached:self.assertEqual(self.result()[0]['state'],'healthy');self.calls.clear()
                count=0
                def after(args):
                    nonlocal count
                    count+=1
                    if count==2:marker.write_text(json.dumps({'version':1,'kind':'employee','identity':EID,'state':'moving'}))
                self.after=after
                self.assertFalse(any(row['state']=='healthy'for row in self.result()))
                self.after=None

    def test_held_lifecycle_mutex_does_not_hide_fresh_native_observations(self):
        from reverie.worker import Broker
        broker=Broker(self.config,config_file=self.path)
        broker.run_engine=self.engine
        entered=threading.Event();release=threading.Event()
        def hold():
            with broker.lock:entered.set();release.wait(5)
        owner=threading.Thread(target=hold);owner.start()
        self.addCleanup(lambda:owner.join(1));self.addCleanup(release.set)
        self.assertTrue(entered.wait(1))
        try:
            started=time.monotonic();value=broker.control('provider-health')
            self.assertLess(time.monotonic()-started,1)
            self.assertFalse(release.is_set());self.assertTrue(owner.is_alive())
            self.assertEqual(value['providerHealth']['purpose'],'worker-provider-health-v1')
            self.assertEqual([row['state']for row in value['providerHealth']['providers']],['healthy'])
            self.assertTrue(any(call[0]=='exec'for call in self.calls))
        finally:release.set();owner.join(1)
        self.assertFalse(owner.is_alive())

    def test_concurrent_initialization_constructs_one_observer_without_queuing(self):
        from reverie.worker import Broker
        broker=Broker(self.config,config_file=self.path)
        entered=threading.Event();release=threading.Event();second_done=threading.Event()
        created=[];results=[];errors=[];threads=[]
        def settle():
            release.set()
            for thread in threads:thread.join(1)
        self.addCleanup(settle)
        proof={'version':1,'purpose':'worker-provider-health-v1','providers':[{'observedAtEpochMs':1234}]}
        def construct(selected):
            self.assertIs(selected,broker);created.append(selected);entered.set()
            self.assertTrue(release.wait(5));return SimpleNamespace(read=lambda:copy.deepcopy(proof))
        def read(done=None):
            try:results.append(broker.control('provider-health'))
            except BaseException as error:errors.append(error)
            finally:
                if done:done.set()
        with patch.object(H,'ProviderHealthObserver',side_effect=construct):
            first=threading.Thread(target=read);first.start();threads.append(first);self.assertTrue(entered.wait(1))
            second=threading.Thread(target=read,args=(second_done,));second.start();threads.append(second)
            try:
                self.assertTrue(second_done.wait(1));self.assertFalse(release.is_set())
                self.assertEqual(results,[{'providerHealth':{'version':1,'purpose':'worker-provider-health-v1','providers':[]}}])
            finally:release.set();first.join(1);second.join(1)
            self.assertFalse(first.is_alive());self.assertFalse(second.is_alive());self.assertEqual(errors,[])
            self.assertEqual(len(created),1);self.assertEqual(results[-1],{'providerHealth':proof})
            self.assertEqual(broker.control('provider-health'),{'providerHealth':proof})
            self.assertEqual(len(created),1)  # Reuse never rewrites observation time.

    def test_control_stopped_or_cleanup_uncertain_still_refuses_before_engine_work(self):
        from reverie.worker import Broker
        for state in ('stopped','cleanup'):
            with self.subTest(state=state):
                broker=Broker(self.config,config_file=self.path)
                broker.run_engine=lambda *args,**kwargs:self.fail('No engine work while stopped/uncertain')
                if state=='stopped':broker.stopping.set()
                else:broker.cleanup_uncertain.add('ENGINE_CLIENT_UNREAPED')
                self.assertEqual(broker.control('provider-health')['providerHealth']['providers'],[])

    def test_late_init_birth_or_runtime_file_change_cannot_publish_cached_healthy(self):
        for changed in ('runtime','init'):
            self.observer.cache.clear();count=0
            def after(args):
                nonlocal count
                count+=1
                if count==2:
                    if changed=='runtime':self.runtime.write_text(json.dumps({'exit':self.exit_name})+' ')
                    else:self.child.terminate();self.child.wait(timeout=3)
            self.after=after
            rows=self.result();self.assertFalse(any(r['state']=='healthy'for r in rows))
            self.after=None


class CacheClockFixture(unittest.TestCase):
    def test_ttl_boundary_is_independent_of_real_monotonic_offset(self):
        # This real-clock offset makes (offset + 5) - offset exceed the
        # inclusive five-second TTL. Keep the existing real-kernel assertions.
        import math
        class OffsetSetup(ProviderHealth):
            def setUp(self):
                clock = SimpleNamespace(monotonic=lambda: math.nextafter(1024., -math.inf))
                with patch(__name__ + '.time', clock):
                    super().setUp()
        result = unittest.TestResult()
        OffsetSetup('test_cache_retains_original_epoch_and_binding_and_expires_monotonically').run(result)
        self.assertEqual(result.errors, [])
        self.assertEqual(result.failures, [])



class BatchScheduling(unittest.TestCase):
    """Orchestration-only timing controls; real kernel joins are tested above.

    Synthetic preparation/probe facts here grant no native qualification. They
    exercise actual read() batching, worker bounds, final guards and cache order.
    """
    def setUp(self):
        F.WorkerTests.setUp(self)
        self.path=self.root/'batch.json';self.path.write_text(json.dumps(self.config));self.path.chmod(0o600)
        self.stopping=StopBudget();self.calls=[];self.active=0;self.peak=0;self.guard=threading.Lock();self.delay=.01
        self.broker=SimpleNamespace(config=self.config,config_file=self.path,stopping=self.stopping,run_engine=self.engine)
        self.observer=H.ProviderHealthObserver(self.broker)
        self.enterContext(patch.object(self.observer,'_prepare',lambda config,b,row:{'binding':b,'key':b['sessionId'],'row':row}))
        self.enterContext(patch.object(self.observer,'_current',lambda *args:None))
        self.enterContext(patch.object(self.observer,'_probe',self.probe))
    def fleet(self,n):
        self.employees=[{'id':f'{i:08x}-1111-4111-8111-111111111111','sessionId':f'{i:08x}-2222-4222-8222-222222222222',
            'sessionGeneration':1,'desiredRunning':True,'onVacation':False}for i in range(1,n+1)]
        path=Path(self.config['companyFile']);path.write_text(json.dumps({'employees':self.employees}));path.chmod(0o600)
    def engine(self,args,optional=False,deadline=None):
        self.assertLessEqual(deadline,time.monotonic()+H.BUDGET)
        self.assertEqual(args[:3],['inspect','--format',H.INSPECT]);self.calls.append(args);time.sleep(self.delay)
        rows=[{'Name':'/'+name,'Id':f'{i+1:064x}','Mounts':[]}for i,name in enumerate(args[3:])]
        return subprocess.CompletedProcess(args,0,'\n'.join(json.dumps(r)for r in rows),'')
    def probe(self,p,end,cached):
        with self.guard:self.active+=1;self.peak=max(self.active,self.peak)
        try:
            # Two slow fixed-engine-equivalent metadata producers, not a claim
            # that any synthetic process is a real provider.
            if time.monotonic()+2*self.delay>=end:return self.observer._unknown(p['binding']),None,time.monotonic()
            time.sleep(2*self.delay)
            value={**self.observer._unknown(p['binding']),'state':'healthy','reason':'LIVE_NATIVE_COMMAND'}
            return value,None,time.monotonic()
        finally:
            with self.guard:self.active-=1
    def test_twelve_and_sixty_four_slow_seats_all_receive_fresh_results_with_two_batched_inspects(self):
        for n in (12,64):
            self.fleet(n);self.calls.clear();self.peak=0
            result=self.observer.read();self.assertEqual(len(result['providers']),n)
            self.assertEqual(sum(r['state']=='healthy'for r in result['providers']),n)
            self.assertEqual(len(self.calls),2);self.assertTrue(all(len(c[3:])==n for c in self.calls));self.assertLessEqual(self.peak,4);self.assertEqual(self.active,0)
    def test_bounded_partial_batches_rotate_and_eventually_observe_every_binding(self):
        self.fleet(12);seen=set();self.delay=.006
        with patch.object(H,'BUDGET',.07):
            for _ in range(12):
                result=self.observer.read();seen.update(r['sessionId']for r in result['providers']if r['state']=='healthy')
                self.assertEqual(self.active,0)
        self.assertEqual(seen,{e['sessionId']for e in self.employees})
    def test_stop_during_fixed_probe_settles_all_four_and_refuses_publication(self):
        self.fleet(12);original=self.probe
        def stopping(*args):
            value=original(*args);self.stopping.set();return value
        with patch.object(self.observer,'_probe',stopping):self.assertEqual(self.observer.read()['providers'],[])
        self.assertEqual(self.active,0);self.assertEqual(self.observer.cache,{})

    def test_retained_client_uncertainty_is_not_cleared_or_published_as_health(self):
        self.fleet(12);self.broker.cleanup_uncertain=set();original=self.probe
        def uncertain(*args):
            value=original(*args);self.broker.cleanup_uncertain.add('ENGINE_CLIENT_UNREAPED');return value
        with patch.object(self.observer,'_probe',uncertain):self.assertEqual(self.observer.read()['providers'],[])
        self.assertEqual(self.broker.cleanup_uncertain,{'ENGINE_CLIENT_UNREAPED'});self.assertEqual(self.observer.cache,{})
        self.calls.clear();self.assertEqual(self.observer.read()['providers'],[]);self.assertEqual(self.calls,[])

    def test_closed_health_payload_over_real_same_uid_socket_never_accepts_selectors_or_caller(self):
        self.fleet(1)
        import socket
        from reverie.worker import Broker,send_frame,receive_frame
        broker=Broker(self.config,config_file=self.path)
        calls=[];errors=[]
        self.enterContext(patch.object(threading,"excepthook",lambda args:errors.append(args.exc_value)))
        broker._provider_health_observer=SimpleNamespace(read=lambda:(calls.append('read')or{'version':1,'purpose':'worker-provider-health-v1','providers':[]}))
        broker.run_engine=lambda *args,**kwargs:self.fail('The protocol fixture must issue no engine work')
        for payload,kind in [({'action':'provider-health'},b'J'),({'action':'provider-health','caller':None},b'E'),
                             ({'action':'provider-health','sessionId':self.employees[0]['sessionId']},b'E')]:
            self.assertTrue(broker.connections.acquire(blocking=False))
            server,client=socket.socketpair();thread=threading.Thread(target=broker.handle,args=(server,));thread.start()
            try:
                send_frame(client,b'C',json.dumps(payload).encode());observed,_=receive_frame(client);self.assertEqual(observed,kind)
            finally:client.close();thread.join(1);server.close()
            self.assertFalse(thread.is_alive())
        self.assertEqual(calls,['read']);self.assertEqual(errors,[])
