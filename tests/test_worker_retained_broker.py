"""Canonical handler ordering with owned files and deliberately fake engine I/O."""
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import unittest
from unittest.mock import patch

from tests import test_worker as fixture
from reverie import worker, worker_retained_tmp

EMP='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'


class RetainedBrokerOrdering(unittest.TestCase):
    def setUp(self):
        fixture.WorkerTests.setUp(self)
        self.config.update(budgetMode='admission',memoryMiB=512,
                           coldTemporaryCleanup={'version':1,'enabled':True,'hostLeaseDirectories':[],
                                                 'strategy':'retain-and-replace'})
        Path(self.config['companyFile']).write_text(json.dumps({'employees':[
            {'id':EMP,'sessionId':fixture.SID,'owner':'fixture','desiredRunning':True,'onVacation':False}]}))
        self.calls=[];self.confirmations=[];self.ready=None

    def run_handler(self, *, commit_failure=False, known_holder=False):
        broker=worker.Broker(self.config);broker.check_pool=lambda *a,**kw:None
        broker.check_creation_budget=lambda *a,**kw:None;broker.office=lambda sid:None
        broker.admit_cold_temporary=lambda *a,**kw:None
        name=self.config['deployment']+'-agent-'+fixture.SID
        def engine(args,optional=False):
            self.calls.append(args)
            if args[0]=='inspect':return subprocess.CompletedProcess(args,1,'','')
            if args[:2]==['network','inspect']:return subprocess.CompletedProcess(args,1,'','')
            if args[0]=='create':return subprocess.CompletedProcess(args,0,'b'*64+'\n','')
            if args[0]=='exec':
                if 'new-session' in args:
                    self.assertFalse(self.pending().exists(),'CLI must not precede confirmed retained commit')
                    raise RuntimeError('owned pre-CLI boundary reached')
                raise AssertionError('unexpected exec')
            return subprocess.CompletedProcess(args,0,'','')
        broker.run_engine=engine
        def prepare(config,paths,guard):
            obs={'counts':{'known':int(known_holder),'unknown':1},'knownReferences':[],
                 'unknownReferences':[{'pid':10,'kind':'FD_IDENTITY_UNAVAILABLE'}],
                 'allInitiallyEnumeratedProcessesVisited':True}
            self.ready=worker_retained_tmp.prepare_retained(config,paths,guard,references=lambda *_a,**_kw:obs)
            self.assertTrue(self.pending().exists())
            return self.ready
        def confirm(paths,ready,cid):
            self.assertTrue(self.pending().exists());self.assertEqual(cid,'b'*64)
            self.confirmations.append(cid)
            if commit_failure:raise RuntimeError('owned native binding refusal')
            return {'containerId':cid,'image':self.config['image'],'pid':123,'startTick':'456'}
        broker.confirm_retained_temporary=confirm
        server,client=socket.socketpair();self.addCleanup(client.close)
        broker.connections.acquire()
        def finish(config,paths,ready,confirmation):
            return worker_retained_tmp.finish_retained(config,paths,ready,confirmation,
                references=lambda *_a,**_kw:{'counts':{'known':0,'unknown':1},'allInitiallyEnumeratedProcessesVisited':True})
        with patch('reverie.worker.prepare_store',return_value=None),patch('reverie.worker.prepare_retained',prepare),patch('reverie.worker.finish_retained',finish):
            thread=threading.Thread(target=broker.handle,args=(server,));thread.start()
            request={**self.request,'env':{}}
            worker.send_frame(client,b'J',json.dumps(request).encode());client.settimeout(10)
            kind,payload=worker.receive_frame(client);thread.join(10)
        self.assertFalse(thread.is_alive());self.assertEqual(kind,b'E')
        return payload.decode()

    def pending(self):return Path(self.config['stateRoot'])/'employees'/EMP/worker.PENDING if hasattr(worker,'PENDING') else Path(self.config['stateRoot'])/'employees'/EMP/'cold-tmp-cleanup.pending.json'

    def test_confirmed_actual_container_commit_precedes_cli(self):
        error=self.run_handler()
        self.assertEqual(error,'owned pre-CLI boundary reached')
        self.assertEqual(self.confirmations,['b'*64,'b'*64])
        self.assertFalse(self.pending().exists())
        self.assertIsNotNone(self.ready)
        self.assertTrue(self.ready.data.is_dir())
        self.assertTrue(any(x[0]=='start' for x in self.calls))

    def test_native_binding_refusal_blocks_cli_and_retains_fence(self):
        error=self.run_handler(commit_failure=True)
        self.assertEqual(error,'owned native binding refusal')
        self.assertTrue(self.pending().exists())
        self.assertFalse(any(x[0]=='exec' for x in self.calls))

    def test_known_holder_refusal_precedes_network_or_container_mutation(self):
        error=self.run_handler(known_holder=True)
        self.assertIn('Known live temporary reference',error)
        self.assertFalse(self.pending().exists())
        self.assertFalse(any(x[0] in ('create','start','exec') or x[:2]==['network','create'] for x in self.calls))


class RetainedNativeConfirmation(unittest.TestCase):
    """Real file/process metadata with a controlled engine/namespace description."""
    def setUp(self):
        fixture.WorkerTests.setUp(self)
        self.config.update(budgetMode='admission',memoryMiB=512,
            coldTemporaryCleanup={'version':1,'enabled':True,'hostLeaseDirectories':[],
                                  'strategy':'retain-and-replace'})
        Path(self.config['companyFile']).write_text(json.dumps({'employees':[
            {'id':EMP,'sessionId':fixture.SID,'owner':'fixture','desiredRunning':True,'onVacation':False}]}))
        self.broker=worker.Broker(self.config)
        self.broker.run_engine=lambda argv,optional=False:subprocess.CompletedProcess(argv,0,'','')
        self.paths,claimed=self.broker.claim_storage(fixture.SID)
        self.addCleanup(lambda:self.broker.release_storage(fixture.SID))
        worker.prepare_storage(self.config,self.paths)
        worker.cold_initialize_leases(self.config,self.paths,fresh_home=True)
        worker.prepare_temporary(self.config,self.paths.scratch)
        self.ready=worker_retained_tmp.prepare_retained(self.config,self.paths,lambda _keys:None,
            references=lambda *_a,**_kw:{'counts':{'known':0,'unknown':1},'allInitiallyEnumeratedProcessesVisited':True})
        self.cid='b'*64
        self.record={'Id':self.cid,'Name':'/test-agent-'+fixture.SID,'Image':self.config['image'],
                     'Config':{'User':str(self.config['uid'])+':'+str(self.config['gid']),
                               'Entrypoint':['/bin/sleep'],'Cmd':['infinity'],
                               'Labels':{'reverie.worker':'test','reverie.session':fixture.SID,'reverie.employee':EMP}},
                     'State':{'Running':True,'Paused':False,'Restarting':False,'Pid':os.getpid(),'StartedAt':'owned-source-fixture'},
                     'Mounts':[{'Type':'bind','Source':str(self.paths.scratch/'tmp'),'Destination':'/tmp','RW':True}]}
        self.broker.run_engine=lambda argv,optional=False:subprocess.CompletedProcess(argv,0,json.dumps([self.record]),'')
        self.host=worker.read_mount_table()
        dev,path=worker._retained_mount_location(self.paths.scratch/'tmp',self.host)
        self.container=[{'id':999,'device':dev,'root':path,'point':Path('/tmp')}]

    def confirm(self):
        with patch('reverie.worker.read_mount_table',side_effect=lambda pid='self':self.host if pid=='self' else self.container):
            return self.broker.confirm_retained_temporary(self.paths,self.ready,self.cid)

    def test_exact_created_cid_pid_namespace_and_fresh_inode_confirm(self):
        result=self.confirm()
        self.assertEqual(result['containerId'],self.cid)
        self.assertEqual(result['pid'],os.getpid())
        self.assertTrue(result['startTick'].isdigit())
        self.assertTrue((self.paths.root/'cold-tmp-cleanup.pending.json').exists())

    def test_wrong_uid_readonly_tmp_or_namespace_each_refuse(self):
        self.record['Config']['User']='different'
        with self.assertRaisesRegex(RuntimeError,'binding differs'):self.confirm()
        self.record['Config']['User']=str(self.config['uid'])+':'+str(self.config['gid'])
        self.record['Mounts'][0]['RW']=False
        with self.assertRaisesRegex(RuntimeError,'mount differs'):self.confirm()
        self.record['Mounts'][0]['RW']=True
        self.container[0]['root']=Path('/unrelated')
        with self.assertRaisesRegex(RuntimeError,'namespace differs'):self.confirm()

    def test_non_sleeping_entrypoint_cannot_commit_before_cli(self):
        self.record['Config']['Entrypoint']=['/bin/bash']
        with self.assertRaisesRegex(RuntimeError,'binding differs'):self.confirm()
        self.assertTrue((self.paths.root/'cold-tmp-cleanup.pending.json').exists())

    def test_current_off_intent_still_refuses(self):
        current=json.loads(Path(self.config['companyFile']).read_text())
        current['employees'][0]['desiredRunning']=False
        Path(self.config['companyFile']).write_text(json.dumps(current))
        with self.assertRaisesRegex(RuntimeError,'binding changed'):self.confirm()

    def test_pid_drift_in_engine_binding_refuses(self):
        calls=0
        def inspect(argv,optional=False):
            nonlocal calls
            calls+=1
            value=json.loads(json.dumps(self.record))
            if calls>1:value['State']['Pid']=os.getpid()+1
            return subprocess.CompletedProcess(argv,0,json.dumps([value]),'')
        self.broker.run_engine=inspect
        with self.assertRaisesRegex(RuntimeError,'drifted'):self.confirm()
