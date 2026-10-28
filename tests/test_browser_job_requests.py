"""Actual fixed source/authority adapter with controlled canonical/native ports."""
import copy,threading,unittest
from types import SimpleNamespace
from unittest.mock import patch,Mock
from reverie import browser_job_requests as requests

SID='00000000-0000-4000-8000-000000000001'
MID='00000000-0000-4000-8000-000000000002'
class RequestControls(unittest.TestCase):
    def native_fixture(self):
        actor=object.__new__(requests.BrowserJobRequests);eid='00000000-0000-4000-8000-000000000003';employee={'id':eid,'sessionId':SID,'sessionGeneration':3,'desiredRunning':True,'owner':None,'runtimeRecipe':{'mode':'codex','configs':{}}};identity={'employeeId':eid,'sessionId':SID,'sessionGeneration':3,'owner':None};config={'companyFile':'unused','uid':0,'deployment':'synthetic','mounts':[{'source':'/owned/account','destination':'/selected-account','readOnly':True}]};actor.broker=SimpleNamespace(config=config)
        row={'Id':'a'*64,'Name':'/synthetic-agent-'+SID,'State':{'Running':True,'Pid':200},'Config':{'Labels':{'reverie.worker':'synthetic','reverie.session':SID,'reverie.employee':eid,'reverie.storage':'employee:'+eid,'reverie.worker-policy':'d'*64}},'Mounts':[{'Type':'bind','Source':'/owned/account','Destination':'/selected-account','RW':False}]}
        actor.native=Mock();actor.native.inventory.side_effect=lambda deadline:[copy.deepcopy(row),{'Id':'c'*64,'Config':{'Labels':None}}];actor.native.limits.return_value=(8192,{'containerId':row['Id'],'pid':200,'start':'9'});actor.native.storage.return_value={'/home/agent':(1,2,0,0,448)};paths=SimpleNamespace(kind='employee',identity=eid,owner=None)
        return actor,identity,employee,row,paths
    def native_ports(self,actor,employee,paths):
        from contextlib import ExitStack
        stack=ExitStack();self.addCleanup(stack.close);stack.enter_context(patch.object(requests,'read_metadata',return_value={'employees':[employee],'retired':[]}));stack.enter_context(patch.object(requests,'storage_paths',return_value=paths));stack.enter_context(patch.object(requests,'storage_start_allowed',return_value=True));stack.enter_context(patch.object(requests,'policy_digest',return_value='d'*64));stack.enter_context(patch.object(requests,'grant_identity',return_value=(1,2,16384)));return stack
    def test_native_current_worker_and_physical_root_ports_bind_the_canonical_actor(self):
        actor,identity,employee,row,paths=self.native_fixture();self.native_ports(actor,employee,paths);proof=actor.native_actor(identity,employee,None);self.assertEqual(proof['native']['containerId'],row['Id']);actor.native.storage.assert_called_once_with(row,paths);self.assertEqual(actor.native.inventory.call_count,2)
    def test_stopped_native_worker_or_foreign_storage_never_becomes_an_actor(self):
        actor,identity,employee,row,paths=self.native_fixture();self.native_ports(actor,employee,paths);row['State']['Running']=False
        with self.assertRaisesRegex(requests.BrowserJobRefused,'WORKER_BINDING'):actor.native_actor(identity,employee,None)
        row['State']['Running']=True;paths.identity='00000000-0000-4000-8000-000000000099'
        with self.assertRaisesRegex(requests.BrowserJobRefused,'EMPLOYEE_STORAGE'):actor.native_actor(identity,employee,None)
    def test_native_restart_during_root_reads_refuses_without_rebinding_to_replacement(self):
        actor,identity,employee,row,paths=self.native_fixture();self.native_ports(actor,employee,paths);changed=copy.deepcopy(row);changed['Id']='b'*64;actor.native.inventory.side_effect=[[row],[changed]]
        with self.assertRaisesRegex(requests.BrowserJobRefused,'WORKER_CHANGED'):actor.native_actor(identity,employee,None)
    def test_wrong_account_guest_root_or_current_recipe_change_refuses(self):
        actor,identity,employee,row,paths=self.native_fixture();self.native_ports(actor,employee,paths)
        with patch.object(requests,'grant_identity',side_effect=[(1,2,16384),(1,2,16384),(1,3,16384)]),self.assertRaisesRegex(requests.BrowserJobRefused,'ACCOUNT_ROOT'):actor.native_actor(identity,employee,None)
        current=copy.deepcopy(employee);current['runtimeRecipe']['subscriptionProfile']={'id':'other','label':'Synthetic other','provider':'openai'}
        with patch.object(requests,'read_metadata',return_value={'employees':[current],'retired':[]}),self.assertRaisesRegex(requests.BrowserJobRefused,'ACCOUNT_CHANGED'):actor.native_actor(identity,employee,None)
    def test_thread_cursor_advancement_alone_does_not_change_selected_account_binding(self):
        actor,identity,employee,row,paths=self.native_fixture();self.native_ports(actor,employee,paths);current=copy.deepcopy(employee);current['runtimeRecipe']['runtimeThreads']={'codex':'synthetic-new-thread'}
        with patch.object(requests,'read_metadata',return_value={'employees':[current],'retired':[]}):self.assertEqual(actor.native_actor(identity,employee,None)['currentActor'],identity)
    def test_final_website_inventory_cannot_ignore_a_late_selected_worker_replacement(self):
        actor,identity,employee,row,paths=self.native_fixture();self.native_ports(actor,employee,paths);proof=actor.native_actor(identity,employee,None);changed=copy.deepcopy(row);changed['Id']='b'*64;actor.native.inventory.side_effect=None;actor.native.inventory.return_value=[changed]
        with self.assertRaisesRegex(requests.BrowserJobRefused,'AFTER_IO'):actor.website(None,native_expected=proof)
    def test_authority_reobserves_after_blocking_custody_and_rejects_owner_loss(self):
        actor=object.__new__(requests.BrowserJobRequests);actor.custody=Mock();actor.canonical_source=Mock(side_effect=[{'owner':'current'},{'owner':'revoked'}])
        with self.assertRaisesRegex(requests.BrowserJobRefused,'DURING_CUSTODY'):actor.authority(SID,MID)
        self.assertEqual(actor.custody.call_count,2);self.assertEqual(actor.canonical_source.call_count,2)

    def test_current_recipe_or_incarnation_change_cannot_renew_original_job(self):
        actor=object.__new__(requests.BrowserJobRequests);actor.custody=Mock();actor.canonical_source=Mock(return_value={'recipe':'new'})
        with self.assertRaisesRegex(requests.BrowserJobRefused,'REVOKED'):actor.authority(SID,MID,{'recipe':'original'})

    def test_current_owner_off_and_duplicate_bindings_refuse_before_upstream(self):
        row={'id':'00000000-0000-4000-8000-000000000003','sessionId':SID,'sessionGeneration':3,'desiredRunning':True,'runtimeRecipe':{},'owner':None};broker=SimpleNamespace(config={'companyFile':'unused','uid':0})
        with patch.object(requests,'read_metadata',return_value={'employees':[row],'retired':[]}):self.assertEqual(requests.selected_actor(broker,SID)[0]['sessionGeneration'],3)
        for employees in [[{**row,'desiredRunning':False}],[{**row,'onVacation':True}],[{**row,'bindingMigration':True}],[row,dict(row)]]:
            with patch.object(requests,'read_metadata',return_value={'employees':employees,'retired':[]}),self.assertRaises(requests.BrowserJobRefused):requests.selected_actor(broker,SID)

    def test_a_worktree_policy_cannot_turn_mutable_actor_sources_into_an_installed_port(self):
        with patch.object(requests,'_program')as native:
            with self.assertRaisesRegex(requests.BrowserJobRefused,'INSTALLED_PRIVATE_ACTOR'):requests.qualify_sources({})
        native.assert_not_called()

    def test_dripping_response_cannot_reset_absolute_office_deadline(self):
        actor=object.__new__(requests.BrowserJobRequests);actor.policy={'ownerCue':{'roomId':'00000000-0000-4000-8000-000000000003'}};actor.broker=SimpleNamespace(config={'companyRoot':'/unread'},address=lambda:'127.0.0.1');clock=[0.];sock=Mock();response=Mock();response.status=200;response.getheader.side_effect=lambda k:'100'if k=='Content-Length'else None
        def read(size):clock[0]=2.;return b'{'  # progress at the deadline is still expiry
        response.read1.side_effect=read;connection=Mock(sock=sock);connection.getresponse.return_value=response
        route='/api/chatrooms/'+actor.policy['ownerCue']['roomId']+'/messages/'+MID+'/browser-job-evidence'
        with patch.object(requests,'private_bytes',return_value=b'REVERIE_PASSWORD=synthetic\n'),patch.object(requests.http.client,'HTTPConnection',return_value=connection),patch.object(requests.time,'monotonic',side_effect=lambda:clock[0]):
            with self.assertRaisesRegex(requests.BrowserJobRefused,'ABSOLUTE_DEADLINE'):actor.office_exchange(SID,'GET',route,b'','application/json',1.)
        response.read1.assert_called_once();connection.close.assert_called_once()

    def test_unknown_chunked_or_wrong_target_response_refuses_without_payload_reads(self):
        actor=object.__new__(requests.BrowserJobRequests);room='00000000-0000-4000-8000-000000000003';actor.policy={'ownerCue':{'roomId':room}};actor.broker=SimpleNamespace(config={'companyRoot':'/unread'},address=lambda:'127.0.0.1');response=Mock(status=200);response.getheader.side_effect=lambda k:'chunked'if k=='Transfer-Encoding'else None;connection=Mock(sock=Mock());connection.getresponse.return_value=response
        with patch.object(requests,'private_bytes',return_value=b'REVERIE_PASSWORD=synthetic\n'),patch.object(requests.http.client,'HTTPConnection',return_value=connection):
            with self.assertRaisesRegex(requests.BrowserJobRefused,'CLOSED_OFFICE_RESPONSE'):actor.office_exchange(SID,'GET','/api/chatrooms/'+room+'/messages/'+MID+'/browser-job-evidence',b'','application/json',None)
            with self.assertRaisesRegex(requests.BrowserJobRefused,'FIXED_OFFICE_ROUTE'):actor.office_exchange(SID,'POST','/api/admin/foreign',b'','application/json',None)
        response.read1.assert_not_called()

if __name__=='__main__':unittest.main()
