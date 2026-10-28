from copy import deepcopy
import hashlib
import json
import subprocess
from unittest.mock import patch
import unittest

from tests import test_worker as fixture
SID=fixture.SID
from reverie.worker import Broker,create_args
from reverie.worker_resources import effective_config,policy_digest,validate_resource_reload,validate_session_resources

OTHER='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

class ResourcePolicyTests(unittest.TestCase):
    # Use only fixture initialization; inherited worker tests also exercise the
    # unchanged default mode against this source.
    def setUp(self):
        fixture.WorkerTests.setUp(self)
        self.config.update(budgetMode='admission',memoryMiB=4096,pidsLimit=512,poolMemoryMiB=44032,poolTasksMax=8192)

    def test_reservation_pool_is_global_and_stale_copies_do_not_change_labels(self):
        stale=self.mixed();stale['resourceReservations']={'configured':True}
        stale.update(poolMemoryMiB=51200,poolTasksMax=4096)
        normalized=deepcopy(stale)
        normalized['sessionResources'][SID].update(poolMemoryMiB=51200,poolTasksMax=4096)
        self.assertEqual(effective_config(stale,SID)['poolMemoryMiB'],51200)
        self.assertEqual(effective_config(stale,SID)['poolTasksMax'],4096)
        self.assertEqual(policy_digest(stale,SID),policy_digest(normalized,SID))
        self.assertEqual(create_args(stale,SID,self.root/'home'),create_args(normalized,SID,self.root/'home'))
        # Legacy mixed-mode labels remain exact when the reservation option is absent.
        legacy=self.mixed();expected={k:v for k,v in legacy.items() if k!='sessionResources'}
        expected.update(legacy['sessionResources'][SID])
        self.assertEqual(effective_config(legacy,SID),expected)

    def test_central_pool_validates_actual_global_limit_and_closed_legacy_fields(self):
        config=self.mixed();config['resourceReservations']={'configured':True}
        config['sessionResources'][SID].update(budgetMode='admission',memoryMiB=50000)
        config['poolMemoryMiB']=51200
        self.assertEqual(effective_config(config,SID)['memoryMiB'],50000)
        for key,value in [('poolMemoryMiB',True),('poolTasksMax',None),('extra',1)]:
            bad=deepcopy(config);bad['sessionResources'][SID][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):effective_config(bad,SID)
        config['poolMemoryMiB']=49152
        with self.assertRaises(ValueError):effective_config(config,SID)

    def mixed(self):
        return {**self.config,'sessionResources':{SID:dict(budgetMode='pool',memoryMiB=0,pidsLimit=4096,cpus=0,poolMemoryMiB=49152,poolTasksMax=8192)}}

    def test_selected_canary_does_not_change_legacy_policy_hash(self):
        expected=hashlib.sha256(json.dumps({k:v for k,v in self.config.items() if k not in ('image','maintenanceSessions')},sort_keys=True).encode()).hexdigest()
        self.assertEqual(policy_digest(self.mixed(),OTHER),expected)
        self.assertEqual(create_args(self.mixed(),OTHER,self.root/'home')[2],create_args(self.config,OTHER,self.root/'home')[2])
        self.assertNotEqual(policy_digest(self.mixed(),SID),expected)
        args=create_args(self.mixed(),SID,self.root/'home')[2]
        self.assertIn('--cgroup-parent',args);self.assertNotIn('--memory',args)

    def test_owner_map_cannot_change_non_resource_grants(self):
        for field in ('mounts','uid','image','gpuGrants','command'):
            changed=deepcopy(self.mixed());changed['sessionResources'][SID][field]='forbidden'
            with self.subTest(field=field),self.assertRaises(ValueError):validate_session_resources(changed)
        changed=deepcopy(self.mixed());changed['mounts'][0]['readOnly']=True
        with self.assertRaises(ValueError):validate_resource_reload(self.config,changed)

    def test_reload_does_not_close_legacy_terminals_or_office_proxies(self):
        broker=Broker(self.config,config_file='unused')
        broker.laptops={OTHER:'test-agent-'+OTHER}
        terminal=object();office=object();broker.active={OTHER:terminal};broker.offices={OTHER:office}
        labels={'reverie.worker':'test','reverie.session':OTHER,'reverie.worker-policy':policy_digest(self.config,OTHER)}
        broker.run_engine=lambda argv,optional=False:subprocess.CompletedProcess(argv,0,json.dumps([{'Config':{'Labels':labels},'State':{'Running':True}}]))
        with patch('reverie.worker.load_config',return_value=self.mixed()):broker.control('reload-resources')
        self.assertIs(broker.active[OTHER],terminal);self.assertIs(broker.offices[OTHER],office)
        self.assertEqual(broker.generation,0)

    def test_live_canary_policy_change_still_refuses(self):
        broker=Broker(self.config,config_file='unused');broker.laptops={SID:'test-agent-'+SID}
        labels={'reverie.worker':'test','reverie.session':SID,'reverie.worker-policy':policy_digest(self.config,SID)}
        broker.run_engine=lambda argv,optional=False:subprocess.CompletedProcess(argv,0,json.dumps([{'Config':{'Labels':labels},'State':{'Running':True}}]))
        with patch('reverie.worker.load_config',return_value=self.mixed()),self.assertRaises(ValueError):broker.control('reload-resources')
        self.assertEqual(broker.config,self.config)

    def test_reload_forbidden_from_a_laptop_caller(self):
        with self.assertRaises(ValueError):Broker(self.config).control('reload-resources',SID)

    def test_stopped_canary_reload_keeps_other_runtime_policy(self):
        broker=Broker(self.config,config_file='unused');broker.laptops={SID:'test-agent-'+SID,OTHER:'test-agent-'+OTHER}
        def inspect(argv,optional=False):
            sid=SID if argv[1].endswith(SID) else OTHER
            labels={'reverie.worker':'test','reverie.session':sid,'reverie.worker-policy':policy_digest(self.config,sid)}
            return subprocess.CompletedProcess(argv,0,json.dumps([{'Config':{'Labels':labels},'State':{'Running':sid!=SID}}]))
        broker.run_engine=inspect
        with patch('reverie.worker.load_config',return_value=self.mixed()):broker.control('reload-resources')
        self.assertEqual(policy_digest(broker.config,OTHER),policy_digest(self.config,OTHER))
        self.assertEqual(effective_config(broker.config,SID)['budgetMode'],'pool')

    def test_reattach_does_not_need_new_task_reservation_but_still_needs_pool_cap(self):
        pool=self.root/'pool';pool.mkdir()
        for name,value in [('memory.max',str(4096*1024*1024)),('pids.max','8192'),('pids.current','8190')]:
            (pool/name).write_text(value)
        broker=Broker(self.mixed());config=effective_config(self.mixed(),SID)
        with self.assertRaises(RuntimeError):broker.check_pool(pool,config=config)
        broker.check_pool(pool,config=config,require_headroom=False)
        (pool/'memory.max').write_text('max')
        with self.assertRaises(RuntimeError):broker.check_pool(pool,config=config,require_headroom=False)

    def test_pool_plus_legacy_memory_must_fit_host_reserve(self):
        pool=self.root/'pool';pool.mkdir()
        proc=self.root/'proc';proc.mkdir();(proc/'meminfo').write_text('MemTotal: 65743872 kB\n')
        (proc/'100').mkdir();(proc/'100/cgroup').write_text('0::/system.slice/docker-legacy.scope\n')
        record={'Config':{'Labels':{'reverie.worker':'test','reverie.session':OTHER}},'State':{'Running':True,'Pid':100},'HostConfig':{'Memory':36*1024**3,'MemorySwap':36*1024**3}}
        broker=Broker(self.mixed())
        def engine(argv,optional=False):
            data='test-agent-'+OTHER if argv[0]=='ps' else json.dumps([record])
            return subprocess.CompletedProcess(argv,0,data)
        broker.run_engine=engine
        (pool/'pids.max').write_text('8192')
        (pool/'memory.max').write_text(str(48*1024**3))
        with self.assertRaises(RuntimeError):broker.check_creation_budget(SID,effective_config(self.mixed(),SID),pool,proc)
        (pool/'memory.max').write_text(str(8*1024**3));broker.check_creation_budget(SID,effective_config(self.mixed(),SID),pool,proc)
        record['HostConfig']['Memory']=0
        with self.assertRaises(RuntimeError):broker.check_creation_budget(SID,effective_config(self.mixed(),SID),pool,proc)

    def test_owner_loader_validates_resource_map(self):
        self.assertEqual(fixture.WorkerTests.load(self,self.mixed()),self.mixed())
        bad=self.mixed();bad['sessionResources'][SID]['pidsLimit']=8192
        with self.assertRaises(ValueError):fixture.WorkerTests.load(self,bad)

    def test_legacy_transport_socket_and_scoped_unix_proxy_survive_reload(self):
        import http.client
        import socket
        from reverie.worker import OfficeAPI
        company=self.root/'company';(company/'console').mkdir(parents=True)
        (company/'console/.env').write_text('REVERIE_USERNAME=fixture\nREVERIE_PASSWORD=fixture-only\n')
        (company/'console/hook-secret').write_text('fixture-only')
        original=http.client.HTTPConnection
        class Response:
            status=200
            def getheaders(self):return [('Content-Length','2')]
            def read1(self,_):
                if getattr(self,'done',False):return b''
                self.done=True;return b'{}'
        class Upstream:
            def __init__(self,*a,**k):self.sock=None
            def request(self,*a,**k):pass
            def getresponse(self):return Response()
            def close(self):pass
        office=OfficeAPI(self.root/'legacy-office',OTHER,'fixture-upstream',company)
        self.addCleanup(office.close)
        terminal,viewer=socket.socketpair();self.addCleanup(terminal.close);self.addCleanup(viewer.close)
        terminal.settimeout(1);viewer.settimeout(1)
        broker=Broker(self.config,config_file='unused')
        broker.laptops={SID:'test-agent-'+SID,OTHER:'test-agent-'+OTHER}
        broker.active={OTHER:terminal};broker.offices={OTHER:office}
        def inspect(argv,optional=False):
            sid=SID if argv[1].endswith(SID) else OTHER
            labels={'reverie.worker':'test','reverie.session':sid,'reverie.worker-policy':policy_digest(self.config,sid)}
            return subprocess.CompletedProcess(argv,0,json.dumps([{'Config':{'Labels':labels},'State':{'Running':sid!=SID}}]))
        broker.run_engine=inspect
        def probe():
            conn=original('localhost');transport=socket.socket(socket.AF_UNIX)
            transport.connect(str(self.root/'legacy-office/office.sock'));conn.sock=transport
            conn.request('GET','/api/status');response=conn.getresponse()
            self.assertEqual(response.status,200);self.assertEqual(response.read(),b'{}');conn.close()
            viewer.sendall(b'live');self.assertEqual(terminal.recv(4),b'live')
        with patch('reverie.worker.http.client.HTTPConnection',Upstream):
            probe()
            with patch('reverie.worker.load_config',return_value=self.mixed()):broker.control('reload-resources')
            probe()

    def attempt_tracked_recreation(self, peer_mib, candidate_mib, budget_mib, max_workers=4, wrong_stopped_peer=False):
        import os
        import socket
        import threading
        from reverie.worker import send_frame,receive_frame
        config={**self.config,'uid':os.getuid(),'memoryMiB':candidate_mib,'poolMemoryMiB':budget_mib,'maxWorkers':max_workers}
        broker=Broker(config);broker.laptops={SID:'test-agent-'+SID,OTHER:'test-agent-'+OTHER}
        proc=self.root/'recreate-proc';proc.mkdir()
        (proc/'meminfo').write_text('MemTotal: 65743872 kB\n')
        (proc/'100').mkdir();(proc/'100/cgroup').write_text('0::/system.slice/docker-peer.scope\n')
        calls=[]
        def engine(argv,optional=False):
            calls.append(argv)
            if argv[:2]==['image','inspect']:
                return subprocess.CompletedProcess(argv,0,json.dumps([{'Config':{'Labels':{}}}]))
            if argv[0]=='ps':return subprocess.CompletedProcess(argv,0,'test-agent-'+OTHER)
            if argv[0]=='inspect':
                sid=SID if argv[1].endswith(SID) else OTHER
                record={'Config':{'Labels':{'reverie.worker':'test','reverie.session':SID if wrong_stopped_peer else sid}},'State':{'Running':sid==OTHER and not wrong_stopped_peer,'Pid':100},'HostConfig':{'Memory':peer_mib*1024**2,'MemorySwap':peer_mib*1024**2}}
                return subprocess.CompletedProcess(argv,0,json.dumps([record]))
            if argv[0]=='network' and argv[1]=='inspect':return subprocess.CompletedProcess(argv,1,'')
            if argv[0]=='create':raise RuntimeError('CREATE_ALLOWED_TRIPWIRE')
            return subprocess.CompletedProcess(argv,0,'')
        broker.run_engine=engine;broker.stop=lambda name:calls.append(['stop',name]);broker.office=lambda _:None
        if hasattr(broker,'check_creation_budget'):
            admission=broker.check_creation_budget
            def checked(sid,resources):
                admission(sid,resources,self.root/'unused-pool',proc)
                calls.append(['admission_pass'])
            broker.check_creation_budget=checked
        server,client=socket.socketpair();client.settimeout(3)
        broker.connections.acquire()
        thread=threading.Thread(target=broker.handle,args=(server,));thread.start()
        try:
            send_frame(client,b'J',json.dumps(self.request).encode())
            kind,message=receive_frame(client);thread.join(3)
            self.assertFalse(thread.is_alive());self.assertEqual(kind,b'E')
        finally:client.close()
        return calls,message.decode()

    def test_tracked_stopped_target_cannot_bypass_full_admission(self):
        calls,message=self.attempt_tracked_recreation(4096,4096,4096)
        self.assertIn('admission is full',message)
        self.assertFalse(any(c[0] in ('stop','rm','create') for c in calls))

    def test_recreation_counts_actual_peer_ceiling_not_requested_default(self):
        calls,message=self.attempt_tracked_recreation(8192,4096,8192)
        self.assertIn('admission is full',message)
        self.assertFalse(any(c[0] in ('stop','rm','create') for c in calls))

    def test_recreation_replaces_only_target_reservation(self):
        calls,message=self.attempt_tracked_recreation(4096,4096,8192)
        self.assertIn('CREATE_ALLOWED_TRIPWIRE',message)
        marker=next(i for i,c in enumerate(calls) if c[0]=='admission_pass')
        self.assertTrue(all(i>marker for i,c in enumerate(calls) if c[0] in ('stop','rm','create')))

    def test_recreation_rechecks_actual_worker_capacity(self):
        calls,message=self.attempt_tracked_recreation(4096,4096,8192,max_workers=1)
        self.assertIn('capacity is full',message)
        self.assertFalse(any(c[0] in ('stop','rm','create') for c in calls))

    def test_misidentified_stopped_peer_is_not_silently_dropped(self):
        calls,message=self.attempt_tracked_recreation(4096,4096,4096,wrong_stopped_peer=True)
        self.assertIn('ownership mismatch',message)
        self.assertFalse(any(c[0] in ('stop','rm','create') for c in calls))
