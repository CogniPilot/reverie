"""Real owned registry files; fake native facts, never the actual owner registry."""
import copy
import json
import multiprocessing
import os
from pathlib import Path
import pwd
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from reverie import owner_control as O


def sha(char):return 'sha256:'+char*64
class Provider:
    def __init__(self,value):self.value=value;self.website=None;self.approved_parents={sha('7')}
    def snapshot(self):return copy.deepcopy(self.value)
    def admit_control_custody(self,binding,paths,sources):
        # Explicit fake test authority. This is NOT production qualification.
        return {**O.custody_digests(binding,paths,sources),'evidenceDigest':O.digest({'fixture':'unqualified'})}
    def admit_unchanged_worker(self,binding,observation,readback):
        O.require(observation['parentPlanDigest'] in self.approved_parents,'fixture parent plan unapproved')
        O.require(readback==O.worker_readback(self.value),'fixture worker readback stale')
        return {'bindingDigest':O.digest(binding),'inputDigest':O.digest(observation),'readbackDigest':O.digest(readback),'evidenceDigest':O.digest({'fake':'unchanged'})}
    def admit_website_adoption(self,binding,intent,receipt):
        expected={'engineId':self.value['engineId'],'newId':receipt['newId'],'newImage':receipt['newImage'],'newRunning':True,'oldId':receipt['oldId'],'oldStopped':True,'worker':O.worker_readback(self.value),'bindingGeneration':binding['generation']}
        O.require(self.website==expected,'fixture actual website not adopted')
        return {'bindingDigest':O.digest(binding),'intentDigest':O.digest(intent),'receiptDigest':O.digest(receipt),'readbackDigest':O.digest(expected),'evidenceDigest':O.digest({'fake':'namespace'})}


def concurrent_begin(home,facts,plan,event,queue):
    registry=O.OwnerControlRegistry.for_fixtures(home,Provider(facts));event.wait(3)
    try:registry.begin('a'*32,plan);queue.put('began')
    except (O.Refused,O.Unconfirmed,OSError):queue.put('refused')


def concurrent_register(home,facts,request,event,queue):
    registry=O.OwnerControlRegistry.for_fixtures(home,Provider(facts));event.wait(3)
    try:registry.register(registry.propose(request));queue.put('registered')
    except (O.Refused,O.Unconfirmed,OSError):queue.put('refused')


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.home=self.root/'home';self.home.mkdir(mode=0o700)
        self.primary=self.root/'website-state';self.primary.mkdir(mode=0o700)
        self.control=self.root/'owner-inputs';self.control.mkdir(mode=0o700)
        self.state=self.root/'control-state';self.state.mkdir(mode=0o700)
        self.maintenance=self.control/'runtime/update-state';self.maintenance.mkdir(parents=True,mode=0o700)
        for name in ('deployment.json','policy.json'):
            path=self.control/name;path.write_text('{}');path.chmod(0o600)
        self.request={'containerName':'website','stateDirectory':str(self.state),'deploymentPath':str(self.control/'deployment.json'),'policyPath':str(self.control/'policy.json'),'maintenanceLockDirectory':str(self.maintenance)}
        self.provider=Provider({'engineId':'actual-owned-fixture-engine','primaryStateDirectory':str(self.primary),'configuredBindSources':[str(self.primary)],'actualBindSources':[str(self.primary)],'workerConfigSha256':sha('1'),'workerImage':sha('a'),'workerDeployment':'owned'})
        self.registry=O.OwnerControlRegistry.for_fixtures(self.home,self.provider)
        self.plan={'kind':'reverie.worker-image.plan','version':1,'unit':O.WORKER_UNIT,'deployment':'owned','oldImage':sha('a'),'newImage':sha('b'),'configSha256':sha('1'),'engineId':self.provider.value['engineId'],'engineEndpointDigest':sha('3'),'brokerInactive':True,'runningLaptops':0,'planDigest':sha('4')};self.plan['planDigest']=O.digest({k:v for k,v in self.plan.items() if k!='planDigest'})
    def observation(self,parent=sha('7')):
        return {'kind':'reverie.owner-control.worker-unchanged','version':1,**O.worker_readback(self.provider.value),'parentPlanDigest':parent}
    def intent(self,child='9'*32,old='c'*64,old_image=sha('c'),new_image=sha('d')):
        return {'version':1,'operationId':child,'name':self.request['containerName'],'oldId':old,'oldImage':old_image,'newImage':new_image,'planDigest':sha('8'),'controlBinding':self.registry.load(),'controlGrantDigest':sha('5'),'specPin':sha('6'),'schemaFloors':['GOAL','AUTH'],'automaticOldImageRollback':False,'finalSpecApproval':'approved'}
    def website_receipt(self,intent,new='d'*64):
        return {'version':1,**{k:intent[k] for k in ('operationId','oldId','oldImage','newImage','planDigest','controlBinding','controlGrantDigest','automaticOldImageRollback')},'phase':'complete','state':'adopted','newId':new,'oldStopped':True,'newStartAttempted':True,'schemaState':'adopted-forward-only','retainedOldName':intent['name']+'-before-'+intent['operationId'],'backup':'website-state.private.tar','checkpointDigest':sha('e')}
    def simulate_adoption(self,intent,receipt):
        self.provider.website={'engineId':self.provider.value['engineId'],'newId':receipt['newId'],'newImage':receipt['newImage'],'newRunning':True,'oldId':receipt['oldId'],'oldStopped':True,'worker':O.worker_readback(self.provider.value),'bindingGeneration':intent['controlBinding']['generation']}
    def registered(self):return self.registry.register(self.registry.propose(self.request))
    def receipt(self):return {'kind':'reverie.worker-image.receipt','version':1,'state':'committed','transactionId':'f'*32,'oldImage':sha('a'),'newImage':sha('b'),'beforeSha256':sha('1'),'afterSha256':sha('2'),'engineId':self.provider.value['engineId'],'unit':self.plan['unit'],'started':False}
    def reopen(self):return O.OwnerControlRegistry.for_fixtures(self.home,self.provider)

    def test_preview_and_missing_load_never_create_registry(self):
        value=self.registry.propose(self.request);self.assertEqual(set(value['binding']),O.BINDING);self.assertTrue(O.sha(value['binding']['generation']))
        self.assertFalse(self.registry.root.exists())
        with self.assertRaises(O.Refused):self.registry.load()
        self.assertFalse(self.registry.root.exists())
    def test_default_home_ignores_environment_override_without_creating_anything(self):
        with patch.dict(os.environ,{'HOME':str(self.home)}):registry=O.OwnerControlRegistry(self.provider)
        self.assertEqual(registry.home,Path(pwd.getpwuid(os.geteuid()).pw_dir))
        self.assertNotEqual(registry.root,self.registry.root)
    def test_missing_or_unqualified_custody_port_refuses_before_registration(self):
        for result in (None,True,{}, {'bindingDigest':sha('0'),'controlPathsDigest':sha('0'),'sourcePathsDigest':sha('0'),'evidenceDigest':sha('0')}):
            with self.subTest(result=result),patch.object(self.provider,'admit_control_custody',return_value=result),self.assertRaises(O.Refused):self.registry.propose(self.request)
            self.assertFalse(self.registry.root.exists())
        self.provider.admit_control_custody=None
        with self.assertRaisesRegex(O.Refused,'provider unavailable'):self.registry.propose(self.request)
    def test_external_custody_rejection_cannot_be_replaced_by_snapshot_facts(self):
        with patch.object(self.provider,'admit_control_custody',side_effect=O.Refused('nested mount unqualified')),self.assertRaisesRegex(O.Refused,'nested mount'):self.registry.propose(self.request)
        self.assertFalse(self.registry.root.exists())
    def test_shared_custody_codec_preserves_unicode_and_passed_order(self):
        binding={'label':'é'};paths=['/owned/é','/owned/ß'];sources=['/shared/é','/shared/a']
        value=O.custody_digests(binding,paths,sources)
        self.assertEqual(value['bindingDigest'],'sha256:'+__import__('hashlib').sha256(b'{"label":"\\u00e9"}').hexdigest())
        self.assertNotEqual(value['controlPathsDigest'],O.custody_digests(binding,list(reversed(paths)),sources)['controlPathsDigest'])
    def test_registration_repeat_is_exact_and_generation_stable(self):
        first=self.registered();file=self.registry.root/('binding-'+first['resourceId']+'.json');info=file.stat();data=file.read_bytes()
        self.assertEqual(first,self.registry.load());self.assertEqual(first,self.registered())
        self.assertEqual(file.read_bytes(),data);self.assertEqual(file.stat().st_ino,info.st_ino)
    def test_unchanged_worker_cannot_use_changed_worker_fence(self):
        self.registered()
        with self.assertRaisesRegex(O.Refused,'unchanged-worker'):self.registry.begin('a'*32,{**self.plan,'newImage':self.plan['oldImage']})
        self.assertIsNone(self.registry.fence())
    def test_atomic_input_file_replacement_does_not_change_resource_key(self):
        before=self.registered();target=Path(self.request['deploymentPath']);new=target.with_name('new.json');new.write_text('{"choice":true}');new.chmod(0o600);new.replace(target)
        self.assertEqual(self.registry.load(),before)
    def test_different_control_state_directory_cannot_rebind(self):
        self.registered();other=self.root/'other-state';other.mkdir(mode=0o700)
        with self.assertRaisesRegex(O.Refused,'migration'):self.registry.propose({**self.request,'stateDirectory':str(other)})
    def test_replaced_control_directory_inode_refuses(self):
        self.registered();self.state.rename(self.root/'old-control');self.state.mkdir(mode=0o700)
        with self.assertRaisesRegex(O.Refused,'stale'):self.registry.load()
    def test_same_primary_replacement_or_engine_change_requires_migration(self):
        self.registered();self.provider.value['engineId']='different-engine'
        with self.assertRaises(O.Refused):self.registry.load()
        with self.assertRaisesRegex(O.Refused,'migration'):self.registry.propose(self.request)
        self.provider.value['engineId']=self.plan['engineId'];self.primary.rename(self.root/'old-primary');self.primary.mkdir(mode=0o700)
        with self.assertRaises(O.Refused):self.registry.load()
        with self.assertRaises(O.Refused):self.registry.propose(self.request)
    def test_primary_rename_same_inode_cannot_create_fresh_binding(self):
        self.registered();other=self.root/'renamed-primary';self.primary.rename(other);self.provider.value['primaryStateDirectory']=str(other)
        self.provider.value['configuredBindSources']=self.provider.value['actualBindSources']=[str(other)]
        with self.assertRaises(O.Refused):self.registry.propose(self.request)
    def test_symlink_input_or_maintenance_alias_refuses(self):
        target=Path(self.request['policyPath']);target.rename(self.control/'original.json');target.symlink_to(self.control/'original.json')
        with self.assertRaises((O.Refused,OSError)):self.registry.propose(self.request)
    def test_control_and_registry_shared_mount_exposure_and_aliases_refuse(self):
        for name in ('configuredBindSources','actualBindSources'):
            original=list(self.provider.value[name])
            for source in (self.control,self.state,self.home):
                self.provider.value[name]=original+[str(source)]
                with self.subTest(kind=name,source=source),self.assertRaises(O.Refused):self.registry.propose(self.request)
            alias=self.root/('alias-'+name);alias.symlink_to(self.control,target_is_directory=True);self.provider.value[name]=original+[str(alias)]
            with self.assertRaises(O.Refused):self.registry.propose(self.request)
            self.provider.value[name]=original
    def test_hardlinked_approval_file_refuses(self):
        os.link(self.control/'policy.json',self.control/'policy-alias.json')
        with self.assertRaises(O.Refused):self.registry.propose(self.request)
    def test_concurrent_begin_has_exactly_one_winner(self):
        self.registered();ctx=multiprocessing.get_context('fork');event=ctx.Event();queue=ctx.Queue()
        children=[ctx.Process(target=concurrent_begin,args=(str(self.home),self.provider.value,self.plan,event,queue)) for _ in range(2)]
        for child in children:child.start()
        event.set();results=[queue.get(timeout=4) for _ in children]
        for child in children:
            child.join(4)
            if child.is_alive():child.terminate();child.join(2);self.fail('owned begin process did not finish')
            self.assertEqual(child.exitcode,0)
        self.assertEqual(sorted(results),['began','refused']);self.assertEqual(self.registry.fence()['state'],'HELD')
    def test_crash_reopen_and_new_operation_remain_held(self):
        self.registered();self.registry.begin('1'*32,self.plan)
        reopened=self.reopen();self.assertEqual(reopened.fence()['record']['phase'],'WORKER_IN_FLIGHT')
        with self.assertRaises(O.Held):reopened.begin('2'*32,self.plan)
    def test_stale_worker_plan_does_not_publish_fence(self):
        self.registered();self.provider.value['workerConfigSha256']=sha('2');self.provider.value['workerImage']=sha('b')
        with self.assertRaises(O.Refused):self.registry.begin('1'*32,self.plan)
        self.assertIsNone(self.registry.fence())
    def test_committed_receipt_and_actual_readback_required_for_advancement(self):
        self.registered();operation=self.registry.begin('1'*32,self.plan);self.provider.value['workerConfigSha256']=sha('2');self.provider.value['workerImage']=sha('b')
        result=operation.worker_committed(self.receipt());self.assertEqual(result['phase'],'WORKER_COMMITTED')
        self.assertEqual(operation.website_in_flight(self.intent())['phase'],'WEBSITE_IN_FLIGHT')
        with self.assertRaises(O.Held):self.reopen().begin('2'*32,self.plan)
    def test_unconfirmed_or_wrong_readback_cannot_advance(self):
        self.registered();operation=self.registry.begin('1'*32,self.plan)
        with self.assertRaises(O.Unconfirmed):operation.worker_committed(self.receipt())
        with self.assertRaises(O.Refused):operation.website_in_flight(self.intent())
        self.assertEqual(self.reopen().fence()['state'],'HELD')
    def test_website_cannot_advance_without_committed_receipt(self):
        self.registered();operation=self.registry.begin('1'*32,self.plan)
        with self.assertRaises(O.Unconfirmed):operation.website_in_flight(self.intent())
        self.assertEqual(self.registry.fence()['record']['phase'],'WORKER_IN_FLIGHT')
    def test_operation_handle_rejects_another_thread(self):
        self.registered();operation=self.registry.begin('1'*32,self.plan);result=[]
        def other():
            try:operation.hold()
            except O.Refused:result.append('refused')
        thread=threading.Thread(target=other);thread.start();thread.join(2);self.assertEqual(result,['refused'])
    def test_begin_fsync_error_never_admits_child_and_existing_fence_holds(self):
        self.registered()
        with patch.object(O.os,'fsync',side_effect=OSError('owned fault')),self.assertRaises(O.Unconfirmed):self.registry.begin('1'*32,self.plan)
        with self.assertRaises(O.Held):self.reopen().begin('2'*32,self.plan)
    def test_advance_fsync_error_poisoned_handle_and_reopen_hold(self):
        self.registered();operation=self.registry.begin('1'*32,self.plan);self.provider.value['workerConfigSha256']=sha('2');self.provider.value['workerImage']=sha('b')
        with patch.object(O.os,'fsync',side_effect=OSError('owned fault')),self.assertRaises(O.Unconfirmed):operation.worker_committed(self.receipt())
        with self.assertRaises(O.Refused):operation.website_in_flight(self.intent())
        with self.assertRaises(O.Held):self.reopen().load()
    def test_registration_fsync_error_retains_pending_no_clean_success(self):
        proposal=self.registry.propose(self.request);fd=O.directory(self.registry.root,self.registry.uid,private=True,create=True);os.close(fd)
        original=O.os.fsync;calls=[]
        def fail_third(fd):
            calls.append(fd)
            if len(calls)==3:raise OSError('owned binding publication fault')
            return original(fd)
        with patch.object(O.os,'fsync',side_effect=fail_third),self.assertRaises(O.Unconfirmed):self.registry.register(proposal)
        self.assertTrue((self.registry.root/'registration.pending').exists())
        with self.assertRaises(O.Held):self.reopen().load()
    def test_fifo_fence_never_blocks_and_cannot_be_retried(self):
        binding=self.registered();os.mkfifo(self.registry.root/('fence-'+binding['resourceId']+'.json'));start=time.monotonic()
        with self.assertRaises(O.Refused):self.registry.fence()
        self.assertLess(time.monotonic()-start,1)
        with self.assertRaises(O.Held):self.registry.begin('1'*32,self.plan)
    def test_altered_record_or_lock_hardlink_refuses(self):
        binding=self.registered();file=self.registry.root/('binding-'+binding['resourceId']+'.json');obj=json.loads(file.read_text());obj['binding']['containerName']='other';file.write_text(json.dumps(obj))
        with self.assertRaises(O.Refused):self.registry.load()
    def test_hardlinked_registry_lock_refuses(self):
        self.registered();os.link(self.registry.root/'registry.lock',self.root/'lock-alias')
        with self.assertRaisesRegex(O.Refused,'registry lock'):self.registry.load()
    def test_registry_symlink_replacement_cannot_be_adopted(self):
        self.registered();old=self.registry.root.with_name('old-registry');self.registry.root.rename(old);self.registry.root.symlink_to(old,target_is_directory=True)
        with self.assertRaises((O.Refused,OSError)):self.registry.load()
    def test_short_regular_file_read_is_not_a_complete_record(self):
        self.registered();original=O.os.read
        def short(fd,size):return original(fd,size)[:-1]
        with patch.object(O.os,'read',side_effect=short),self.assertRaisesRegex(O.Refused,'short/changed'):self.registry.load()
    def test_outer_lock_cleanup_failure_after_begin_is_unconfirmed_and_stays_held(self):
        self.registered();original=O.os.close;failed=[]
        def close(fd):
            try:name=os.readlink('/proc/self/fd/'+str(fd))
            except OSError:name=''
            original(fd)
            if name.endswith('/registry.lock') and not failed:
                failed.append(fd);raise OSError('owned cleanup fault after close')
        with patch.object(O.os,'close',side_effect=close),self.assertRaises(O.Unconfirmed):self.registry.begin('1'*32,self.plan)
        self.assertTrue(failed)
        with self.assertRaises(O.Held):self.reopen().begin('2'*32,self.plan)

    def adopted_unchanged(self,operation_id='1'*32,child='9'*32):
        self.registered();op=self.registry.begin_unchanged(operation_id,self.observation());intent=self.intent(child=child)
        op.website_in_flight(intent);receipt=self.website_receipt(intent);self.simulate_adoption(intent,receipt);op.website_adopted(receipt)
        return intent,receipt
    def test_two_successive_changed_then_unchanged_operations_preserve_history(self):
        self.registered();op=self.registry.begin('1'*32,self.plan)
        self.provider.value.update(workerImage=sha('b'),workerConfigSha256=sha('2'))
        op.worker_committed(self.receipt());first=self.intent();op.website_in_flight(first)
        first_receipt=self.website_receipt(first);self.simulate_adoption(first,first_receipt)
        self.assertEqual(op.website_adopted(first_receipt)['phase'],'ADOPTED')
        self.assertEqual(self.reopen().fence()['historyCount'],1)
        second=self.reopen().begin_unchanged('2'*32,self.observation())
        intent=self.intent(child='8'*32,old=first_receipt['newId'],old_image=first_receipt['newImage'],new_image=sha('e'))
        second.website_in_flight(intent);receipt=self.website_receipt(intent,new='e'*64);self.simulate_adoption(intent,receipt)
        second.website_adopted(receipt)
        self.assertEqual(self.reopen().fence()['historyCount'],2)
        self.assertEqual(len(list(self.registry.root.glob('history-*.json'))),2)
    def test_unchanged_then_changed_operation_is_explicit_and_forward_only(self):
        _,prior=self.adopted_unchanged()
        second=self.registry.begin('2'*32,self.plan)
        self.provider.value.update(workerImage=sha('b'),workerConfigSha256=sha('2'));second.worker_committed(self.receipt())
        intent=self.intent(child='8'*32,old=prior['newId'],old_image=prior['newImage'],new_image=sha('e'))
        second.website_in_flight(intent);receipt=self.website_receipt(intent,new='e'*64);self.simulate_adoption(intent,receipt);second.website_adopted(receipt)
        self.assertEqual(self.registry.fence()['historyCount'],2)
    def test_mutated_child_plan_digest_unit_deployment_or_actual_image_refuses(self):
        self.registered()
        for changes in ({'planDigest':sha('0')},{'unit':'unrelated.service'},{'deployment':'other'},{'oldImage':sha('c')},{'configSha256':sha('2')}):
            plan={**self.plan,**changes}
            if 'planDigest' not in changes:plan['planDigest']=O.digest({k:v for k,v in plan.items() if k!='planDigest'})
            with self.subTest(changes=changes),self.assertRaises(O.Refused):self.registry.begin('1'*32,plan)
            self.assertIsNone(self.registry.fence())
    def test_unchanged_admission_requires_closed_provider_record_and_approved_parent(self):
        self.registered();original=self.provider.admit_unchanged_worker
        for value in (None,False,{}, {'bindingDigest':sha('0'),'inputDigest':sha('0'),'readbackDigest':sha('0'),'evidenceDigest':sha('0')}):
            with self.subTest(value=value),patch.object(self.provider,'admit_unchanged_worker',return_value=value),self.assertRaises(O.Refused):self.registry.begin_unchanged('1'*32,self.observation())
            self.assertIsNone(self.registry.fence())
        with patch.object(self.provider,'admit_unchanged_worker',None),self.assertRaises(O.Refused):self.registry.begin_unchanged('1'*32,self.observation())
        with self.assertRaisesRegex(O.Refused,'unapproved'):self.registry.begin_unchanged('1'*32,self.observation(parent=sha('0')))
        self.assertIsNone(self.registry.fence())
    def test_unchanged_observation_exact_native_facts_are_required(self):
        self.registered()
        for changes in ({'engineId':'other'},{'unit':'other.service'},{'deployment':'other'},{'image':sha('c')},{'configSha256':sha('3')},{'version':True},{'extra':True}):
            with self.subTest(changes=changes),self.assertRaises(O.Refused):self.registry.begin_unchanged('1'*32,{**self.observation(),**changes})
            self.assertIsNone(self.registry.fence())
    def test_committed_claim_without_actual_new_image_is_unconfirmed(self):
        self.registered();op=self.registry.begin('1'*32,self.plan);self.provider.value['workerConfigSha256']=sha('2')
        with self.assertRaises(O.Unconfirmed):op.worker_committed(self.receipt())
        with self.assertRaises(O.Held):self.reopen().begin_unchanged('2'*32,self.observation())
    def test_committed_before_hash_cannot_claim_new_image(self):
        self.registered();op=self.registry.begin('1'*32,self.plan);self.provider.value['workerImage']=sha('b')
        with self.assertRaises(O.Unconfirmed):op.worker_committed({**self.receipt(),'afterSha256':sha('1')})
        self.assertEqual(self.registry.fence()['state'],'HELD')
    def test_worker_drift_after_commit_refuses_before_website_effects(self):
        self.registered();op=self.registry.begin('1'*32,self.plan);self.provider.value.update(workerImage=sha('b'),workerConfigSha256=sha('2'));op.worker_committed(self.receipt())
        self.provider.value['workerConfigSha256']=sha('3')
        with self.assertRaises(O.Unconfirmed):op.website_in_flight(self.intent())
        self.assertEqual(self.registry.fence()['record']['phase'],'WORKER_COMMITTED')
    def test_unchanged_worker_drift_refuses_before_website_effects(self):
        self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());self.provider.value['workerImage']=sha('b')
        with self.assertRaises(O.Unconfirmed):op.website_in_flight(self.intent())
        self.assertEqual(self.registry.fence()['record']['phase'],'WORKER_UNCHANGED')
    def test_closed_forward_intent_and_control_binding_are_required(self):
        self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());intent=self.intent();intent['automaticOldImageRollback']=True
        with self.assertRaises(O.Unconfirmed):op.website_in_flight(intent)
        self.assertEqual(self.registry.fence()['record']['phase'],'WORKER_UNCHANGED')
    def test_wrong_or_partial_website_receipt_never_creates_adopted_history(self):
        self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());intent=self.intent();op.website_in_flight(intent);receipt=self.website_receipt(intent);receipt['operationId']='8'*32
        self.simulate_adoption(intent,receipt)
        with self.assertRaises(O.Unconfirmed):op.website_adopted(receipt)
        with self.assertRaises(O.Held):self.reopen().begin_unchanged('2'*32,self.observation())
        self.assertFalse(list(self.registry.root.glob('history-*.json')))
    def test_missing_adoption_provider_never_substitutes_receipt_boolean(self):
        self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());intent=self.intent();op.website_in_flight(intent);receipt=self.website_receipt(intent);self.simulate_adoption(intent,receipt)
        with patch.object(self.provider,'admit_website_adoption',None),self.assertRaises(O.Unconfirmed):op.website_adopted(receipt)
        self.assertFalse(list(self.registry.root.glob('history-*.json')))
    def test_actual_website_readback_is_required_before_adopted(self):
        self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());intent=self.intent();op.website_in_flight(intent)
        with self.assertRaises(O.Unconfirmed):op.website_adopted(self.website_receipt(intent))
        self.assertFalse(list(self.registry.root.glob('history-*.json')))
    def test_adopted_state_requires_fresh_provider_before_next_explicit_begin(self):
        self.adopted_unchanged();self.provider.website['newRunning']=False
        with self.assertRaises(O.Held):self.reopen().begin_unchanged('2'*32,self.observation())
        self.assertEqual(self.reopen().fence()['state'],'HELD')
    def test_success_does_not_allow_duplicate_parent_or_child_operation_ids(self):
        self.adopted_unchanged()
        for duplicate in ('1'*32,'9'*32):
            with self.subTest(duplicate=duplicate),self.assertRaises(O.Held):self.registry.begin_unchanged(duplicate,self.observation())
        op=self.registry.begin_unchanged('2'*32,self.observation());intent=self.intent(old='d'*64,old_image=sha('d'),new_image=sha('e'))
        with self.assertRaises(O.Unconfirmed):op.website_in_flight(intent)
    def test_new_intent_must_continue_previous_adopted_container_identity(self):
        self.adopted_unchanged();op=self.registry.begin_unchanged('2'*32,self.observation())
        with self.assertRaises(O.Unconfirmed):op.website_in_flight(self.intent(child='8'*32))
    def test_missing_or_modified_history_refuses_repeat_operation(self):
        self.adopted_unchanged();history=next(self.registry.root.glob('history-*.json'));history.write_text('{}')
        with self.assertRaises(O.Held):self.reopen().begin_unchanged('2'*32,self.observation())
        self.assertEqual(self.registry.fence()['state'],'HELD')
    def test_crash_after_history_before_current_adopted_remains_held(self):
        self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());intent=self.intent();op.website_in_flight(intent);receipt=self.website_receipt(intent);self.simulate_adoption(intent,receipt)
        original=O.write
        def crash(fd,name,value,**kw):
            if name.startswith('fence-') and value.get('phase')=='ADOPTED':raise OSError('owned crash after history')
            return original(fd,name,value,**kw)
        with patch.object(O,'write',side_effect=crash),self.assertRaises(O.Unconfirmed):op.website_adopted(receipt)
        self.assertEqual(len(list(self.registry.root.glob('history-*.json'))),1)
        with self.assertRaises(O.Held):self.reopen().begin_unchanged('2'*32,self.observation())
    def test_adoption_close_fault_retains_unconfirmed_latch(self):
        self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());intent=self.intent();op.website_in_flight(intent);receipt=self.website_receipt(intent);self.simulate_adoption(intent,receipt)
        original=O.os.close;failed=[]
        def close(fd):
            try:name=os.readlink('/proc/self/fd/'+str(fd))
            except OSError:name=''
            original(fd)
            if name.endswith('/registry.lock') and not failed:failed.append(fd);raise OSError('owned cleanup after adoption')
        with patch.object(O.os,'close',side_effect=close),self.assertRaises(O.Unconfirmed):op.website_adopted(receipt)
        self.assertTrue(list(self.registry.root.glob('.tmp-unconfirmed-*')))
        with self.assertRaises(O.Held):self.reopen().begin_unchanged('2'*32,self.observation())

    def test_missing_native_snapshot_provider_is_explicit_refusal(self):
        registry=O.OwnerControlRegistry.for_fixtures(self.home,None)
        with self.assertRaisesRegex(O.Refused,'facts provider unavailable'):registry.propose(self.request)
        self.assertFalse(registry.root.exists())
    def test_adoption_provider_record_must_match_intent_receipt_and_actual_readback(self):
        self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());intent=self.intent();op.website_in_flight(intent);receipt=self.website_receipt(intent);self.simulate_adoption(intent,receipt)
        record=self.provider.admit_website_adoption(intent['controlBinding'],intent,receipt);record['readbackDigest']=sha('0')
        with patch.object(self.provider,'admit_website_adoption',return_value=record),self.assertRaises(O.Unconfirmed):op.website_adopted(receipt)
        self.assertFalse(list(self.registry.root.glob('history-*.json')))
        self.assertEqual(self.registry.fence()['record']['phase'],'WEBSITE_IN_FLIGHT')
    def test_held_operation_cannot_complete_even_with_a_valid_receipt(self):
        self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());intent=self.intent();op.website_in_flight(intent);receipt=self.website_receipt(intent);self.simulate_adoption(intent,receipt);op.hold()
        with self.assertRaises(O.Unconfirmed):op.website_adopted(receipt)
        self.assertEqual(self.registry.fence()['record']['phase'],'HELD')
    def test_replayed_complete_receipt_cannot_rewrite_history(self):
        self.adopted_unchanged();before={p.name:p.read_bytes() for p in self.registry.root.glob('history-*.json')}
        with self.assertRaises(O.Held):self.registry.begin_unchanged('1'*32,self.observation())
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.registry.root.glob('history-*.json')})
        self.assertEqual(self.registry.fence()['state'],'ADOPTED')
    def test_adoption_fsync_failure_never_returns_completion_or_permits_next_begin(self):
        self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());intent=self.intent();op.website_in_flight(intent);receipt=self.website_receipt(intent);self.simulate_adoption(intent,receipt)
        with patch.object(O.os,'fsync',side_effect=OSError('owned durable-history fault')),self.assertRaises(O.Unconfirmed):op.website_adopted(receipt)
        with self.assertRaises(O.Held):self.reopen().begin_unchanged('2'*32,self.observation())
        with self.assertRaises(O.Refused):op.website_adopted(receipt)
    def test_partial_history_file_is_not_completed_adoption(self):
        self.adopted_unchanged();history=next(self.registry.root.glob('history-*.json'));history.write_bytes(b'{')
        with self.assertRaises((O.Held,O.Refused,json.JSONDecodeError)):self.reopen().begin_unchanged('2'*32,self.observation())
    def test_missing_forward_checkpoint_or_wrong_control_binding_refuses_receipt(self):
        self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());intent=self.intent();op.website_in_flight(intent);receipt=self.website_receipt(intent);receipt.pop('checkpointDigest')
        with self.assertRaises(O.Unconfirmed):op.website_adopted(receipt)
        self.assertFalse(list(self.registry.root.glob('history-*.json')))

    def test_registry_scan_consumes_only_cap_plus_one_real_owned_entries(self):
        folder=self.root/'bounded-directory';folder.mkdir(mode=0o700)
        for index in range(4100):(folder/str(index)).touch(mode=0o600)
        fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY);self.addCleanup(os.close,fd)
        original=O.os.scandir;consumed=[]
        class Counted:
            def __init__(self,selected):self.actual=original(selected)
            def __enter__(self):return self
            def __exit__(self,*args):self.actual.close()
            def __iter__(self):return self
            def __next__(self):
                value=next(self.actual);consumed.append(value.name);return value
        with patch.object(O.os,'scandir',Counted),self.assertRaisesRegex(O.Refused,'entry bound'):self.registry._scan(fd)
        self.assertEqual(len(consumed),4097)

    def second_resource(self):
        second=RegistryTests();second.root=self.root;second.home=self.home
        second.primary=self.root/'website-state-two';second.primary.mkdir(mode=0o700)
        second.control=self.root/'owner-inputs-two';second.control.mkdir(mode=0o700)
        second.state=self.root/'control-state-two';second.state.mkdir(mode=0o700)
        second.maintenance=second.control/'runtime/update-state';second.maintenance.mkdir(parents=True,mode=0o700)
        for name in ('deployment.json','policy.json'):
            path=second.control/name;path.write_text('{}');path.chmod(0o600)
        second.request={'containerName':'website-two','stateDirectory':str(second.state),'deploymentPath':str(second.control/'deployment.json'),'policyPath':str(second.control/'policy.json'),'maintenanceLockDirectory':str(second.maintenance)}
        facts=copy.deepcopy(self.provider.value);facts['primaryStateDirectory']=str(second.primary)
        for field in ('configuredBindSources','actualBindSources'):
            self.provider.value[field].append(str(second.primary));facts[field]=list(self.provider.value[field])
        second.provider=Provider(facts);second.registry=O.OwnerControlRegistry.for_fixtures(self.home,second.provider);second.plan=copy.deepcopy(self.plan)
        return second
    def complete(self,op,child='9'*32,old='c'*64,old_image=sha('c'),new_image=sha('d'),new='d'*64):
        intent=self.intent(child=child,old=old,old_image=old_image,new_image=new_image);op.website_in_flight(intent)
        receipt=self.website_receipt(intent,new=new);self.simulate_adoption(intent,receipt);op.website_adopted(receipt)
        return receipt
    def test_registration_requires_full_path_capacity_before_binding_publication(self):
        with patch.object(O,'MAX_ENTRIES',5),self.assertRaisesRegex(O.Refused,'capacity'):self.registered()
        self.assertFalse(list(self.registry.root.glob('binding-*')))
        self.assertFalse((self.registry.root/'registration.pending').exists())
    def test_exact_global_boundary_completes_and_next_begin_refuses_before_effects(self):
        with patch.object(O,'MAX_ENTRIES',6):
            self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());self.complete(op)
            self.assertEqual(self.registry.fence()['state'],'ADOPTED');before={p.name:p.read_bytes() for p in self.registry.root.iterdir()}
            with self.assertRaisesRegex(O.Refused,'capacity'):self.registry.begin_unchanged('2'*32,self.observation())
            self.assertEqual(before,{p.name:p.read_bytes() for p in self.registry.root.iterdir()})
            self.assertEqual(self.registry.load()['containerName'],'website')
    def test_exact_resource_history_boundary_refuses_before_replacing_adopted_fence(self):
        with patch.object(O,'MAX_HISTORIES',1):
            self.adopted_unchanged();before=self.registry.fence()['record']
            with self.assertRaisesRegex(O.Refused,'history capacity'):self.registry.begin_unchanged('2'*32,self.observation())
            self.assertEqual(self.registry.fence()['record'],before)
    def test_binding_count_limit_refuses_a_second_resource_without_publication(self):
        self.registered();other=self.second_resource()
        with patch.object(O,'MAX_BINDINGS',1),self.assertRaisesRegex(O.Refused,'registration capacity'):other.registered()
        self.assertEqual(len(list(self.registry.root.glob('binding-*'))),1)
    def test_other_resource_cannot_consume_outstanding_completion_reservation(self):
        self.registered();other=self.second_resource();other.registered()
        with patch.object(O,'MAX_ENTRIES',10):
            first=self.registry.begin_unchanged('1'*32,self.observation());before={p.name:p.read_bytes() for p in self.registry.root.iterdir()}
            with self.assertRaisesRegex(O.Refused,'capacity'):other.registry.begin_unchanged('2'*32,other.observation())
            self.assertEqual(before,{p.name:p.read_bytes() for p in self.registry.root.iterdir()})
            self.complete(first)
            second=other.registry.begin_unchanged('2'*32,other.observation());other.complete(second,child='8'*32)
            self.assertEqual(self.registry.fence()['state'],'ADOPTED');self.assertEqual(other.registry.fence()['state'],'ADOPTED')
    def test_exact_two_resource_capacity_allows_interleaved_successes(self):
        self.registered();other=self.second_resource();other.registered()
        with patch.object(O,'MAX_ENTRIES',11):
            first=self.registry.begin_unchanged('1'*32,self.observation());second=other.registry.begin_unchanged('2'*32,other.observation())
            self.complete(first);other.complete(second,child='8'*32)
            self.assertEqual(len(list(self.registry.root.iterdir())),7)
            self.assertEqual(self.registry.fence()['state'],'ADOPTED');self.assertEqual(other.registry.fence()['state'],'ADOPTED')
    def test_registration_cannot_consume_another_resource_reserved_space(self):
        self.registered();other=self.second_resource()
        with patch.object(O,'MAX_ENTRIES',8):
            self.registry.begin_unchanged('1'*32,self.observation());before={p.name:p.read_bytes() for p in self.registry.root.iterdir()}
            with self.assertRaisesRegex(O.Refused,'capacity'):other.registered()
            self.assertEqual(before,{p.name:p.read_bytes() for p in self.registry.root.iterdir()})
    def test_partial_adoption_history_temp_and_poison_stay_within_reserved_bound(self):
        with patch.object(O,'MAX_ENTRIES',6):
            self.registered();op=self.registry.begin_unchanged('1'*32,self.observation());intent=self.intent();op.website_in_flight(intent);receipt=self.website_receipt(intent);self.simulate_adoption(intent,receipt)
            original=O.os.fsync;failed=[]
            def fail_fence(fd):
                target=os.readlink('/proc/self/fd/'+str(fd))
                if '/.tmp-' in target and not failed:failed.append(fd);raise OSError('owned temporary durability fault')
                return original(fd)
            with patch.object(O.os,'fsync',side_effect=fail_fence),self.assertRaises(O.Unconfirmed):op.website_adopted(receipt)
            self.assertEqual(len(list(self.registry.root.iterdir())),6)
            with self.assertRaises(O.Held):self.reopen().begin_unchanged('2'*32,self.observation())

    def test_missing_lock_in_nonempty_registry_refuses_without_recreation(self):
        self.registered();proposal=self.registry.propose(self.request);lock=self.registry.root/'registry.lock';lock.unlink()
        before={p.name:p.read_bytes() for p in self.registry.root.iterdir()}
        with self.assertRaisesRegex(O.Refused,'no automatic repair'):self.registry.register(proposal)
        self.assertFalse(lock.exists());self.assertEqual(before,{p.name:p.read_bytes() for p in self.registry.root.iterdir()})
    def test_empty_registry_preview_is_read_only_and_explicit_initialization_succeeds(self):
        fd=O.directory(self.registry.root,self.registry.uid,private=True,create=True);os.close(fd)
        proposal=self.registry.propose(self.request);self.assertFalse(list(self.registry.root.iterdir()))
        self.registry.register(proposal);self.assertEqual((self.registry.root/'registry.lock').stat().st_size,0)
    def test_nonempty_lock_is_not_truncated_or_adopted(self):
        self.registered();lock=self.registry.root/'registry.lock';lock.write_bytes(b'foreign lock content')
        with self.assertRaisesRegex(O.Refused,'registry lock'):self.registry.load()
        self.assertEqual(lock.read_bytes(),b'foreign lock content')
    def test_fifo_registry_lock_refuses_without_waiting_for_a_writer(self):
        self.registered();lock=self.registry.root/'registry.lock';lock.unlink();os.mkfifo(lock,mode=0o600);start=time.monotonic()
        with self.assertRaisesRegex(O.Refused,'registry lock'):self.registry.load()
        self.assertLess(time.monotonic()-start,1)
    def test_lock_content_drift_during_held_scope_is_unconfirmed_on_exit(self):
        self.registered();lock=self.registry.root/'registry.lock';before=lock.stat().st_ino
        with self.assertRaises(O.Unconfirmed):
            with self.registry._locked(exclusive=True):lock.write_bytes(b'drift')
        self.assertEqual(lock.stat().st_ino,before);self.assertEqual(lock.read_bytes(),b'drift')
        with self.assertRaises(O.Refused):self.reopen().load()
    def test_concurrent_explicit_empty_initialization_has_one_valid_lock(self):
        ctx=multiprocessing.get_context('fork');event=ctx.Event();queue=ctx.Queue()
        children=[ctx.Process(target=concurrent_register,args=(str(self.home),self.provider.value,self.request,event,queue)) for _ in range(2)]
        for child in children:child.start()
        event.set();results=[queue.get(timeout=4) for _ in children]
        for child in children:
            child.join(4)
            if child.is_alive():child.terminate();child.join(2);self.fail('owned initialization process did not finish')
            self.assertEqual(child.exitcode,0)
        self.assertIn('registered',results);self.assertEqual(self.registry.load()['containerName'],'website')
        lock=self.registry.root/'registry.lock';self.assertEqual(lock.stat().st_size,0);self.assertEqual(lock.stat().st_nlink,1)
        self.assertFalse((self.registry.root/'registration.pending').exists())

if __name__=='__main__':unittest.main()
