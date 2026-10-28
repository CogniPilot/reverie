"""Owned real stores and phase files; no owner/bootstrap/native acceptance."""
import copy
import json
from pathlib import Path
import unittest
import threading
import types
from unittest.mock import patch

from reverie import laptop_resource_operations as J
from reverie import worker_resource_preparation as P
from reverie.worker_resources import effective_config, policy_digest
from reverie.worker import Broker, load_config
from reverie.worker_storage import record_storage_binding, storage_paths
from tests import test_worker_resource_reservations as F


class Preparation(unittest.TestCase):
    def setUp(self):
        self.f=F.Reservations();self.f.setUp();self.addCleanup(self.f.doCleanups)
        f=self.f;f.native.resource_reservations=f.gate
        record_storage_binding(f.config,storage_paths(f.config,F.SID))
        self.owner=P.ResourcePreparationOwner(f.native);self.addCleanup(self.owner.close)
        self.profile_bytes=(f.control/'profiles/profiles.json').read_bytes()

    def claim(self):
        draft=self.owner.draft(F.EID,F.KEY)
        result=self.owner.reserve(draft['draftId'],draft['previewDigest']);return result['claimKey']

    def publish(self):
        f=self.f;row=dict(f.employee,sessionId=F.APPROVED_TARGET,sessionGeneration=2)
        Path(f.config['companyFile']).write_text(json.dumps({'employees':[row]}))

    def raw(self):
        return json.loads((self.f.control/'operations/operations.json').read_text())

    def test_retains_same_active_handle_and_cold_or_replayed_claim_cannot_replace_it(self):
        key=self.claim();claim=self.owner._current(key);lease=claim['lease']
        self.assertFalse(lease.closed);self.assertIsNotNone(lease.handle)
        with self.assertRaises(ValueError):self.owner._current(object())
        cold=P.ResourcePreparationOwner(self.f.native);self.addCleanup(cold.close)
        draft=json.loads(next((self.f.control/'operations').glob('draft-*.json')).read_text())
        with self.assertRaises(J.OperationCommitUncertain):cold.reserve(draft['draftId'],J.fingerprint(draft))
        self.assertEqual(len(self.raw()['operations']),1)
        self.owner.close();self.assertTrue(lease.closed)
        self.assertEqual(self.f.gate.inspect(F.KEY)['operation']['state'],'RECOVERY_REQUIRED')

    def test_preparing_is_durable_before_metadata_and_profile_is_never_rewritten(self):
        key=self.claim();receipt=self.owner.begin_prepare(key);op=next(iter(self.raw()['operations'].values()))
        self.assertEqual((op['state'],op['version']),('PREPARING',2))
        self.assertEqual(receipt['state'],'PREPARING')
        phase=json.loads((self.f.control/'operations'/('publication-'+op['id']+'.json')).read_text())
        self.assertEqual(phase['beforeEmployee']['sessionId'],F.SID)
        self.assertEqual(phase['afterEmployee']['sessionId'],F.APPROVED_TARGET)
        self.assertEqual(json.loads(Path(self.f.config['companyFile']).read_text())['employees'],[self.f.employee])
        self.assertEqual((self.f.control/'profiles/profiles.json').read_bytes(),self.profile_bytes)
        with self.assertRaisesRegex(ValueError,'ALREADY_ATTEMPTED'):self.owner.begin_prepare(key)
        self.assertEqual(self.raw()['operations'][op['id']]['version'],2)

    def test_intended_publication_uses_old_native_identity_and_same_eid_storage(self):
        key=self.claim();self.owner.begin_prepare(key);self.publish()
        result=self.owner.confirm_publication(key)
        self.assertEqual(result,{'state':'PUBLISHED_METADATA_ONLY','verified':False,'retryAllowed':False})
        staged=self.owner.stage_configuration(key);candidate=staged['config']
        self.assertEqual(staged['state'],'STAGED_ONLY_NOT_RELOADED')
        self.assertEqual(effective_config(candidate,F.APPROVED_TARGET)['memoryMiB'],4096)
        self.assertEqual(policy_digest(candidate,F.SID),policy_digest(self.f.config,F.SID))
        self.assertEqual(effective_config(candidate,F.SID)['memoryMiB'],2048)
        self.assertEqual(candidate['employeeResources'][F.EID]['memoryMiB'],4096)
        self.assertEqual((self.f.control/'profiles/profiles.json').read_bytes(),self.profile_bytes)
        self.assertNotIn('employeeResources',self.f.config)
        with self.assertRaisesRegex(ValueError,'RECONCILIATION'):
            with self.f.gate.admission(F.APPROVED_TARGET):pass

    def test_foreign_publication_or_owner_stop_is_not_the_intended_phase(self):
        key=self.claim();self.owner.begin_prepare(key);self.publish()
        path=Path(self.f.config['companyFile']);value=json.loads(path.read_text())
        value['employees'][0]['onVacation']=True;path.write_text(json.dumps(value))
        with self.assertRaises(J.OperationCommitUncertain):self.owner.confirm_publication(key)
        self.assertEqual(next(iter(self.raw()['operations'].values()))['state'],'PREPARING')
        self.assertEqual(self.f.gate.inspect(F.KEY)['operation']['state'],'RECOVERY_REQUIRED')

    def test_publication_before_intent_and_forged_key_cannot_stage(self):
        key=self.claim()
        with self.assertRaisesRegex(ValueError,'INTENT_REQUIRED'):self.owner.confirm_publication(key)
        with self.assertRaisesRegex(ValueError,'PUBLICATION_REQUIRED'):self.owner.stage_configuration(key)
        with self.assertRaisesRegex(ValueError,'ACTIVE_HANDLE_REQUIRED'):self.owner.begin_prepare(object())
        self.assertEqual(next(iter(self.raw()['operations'].values()))['state'],'RESERVED')

    def test_publication_intent_ack_loss_keeps_preparing_and_cannot_retry(self):
        key=self.claim();write=P._write_exclusive
        def lost(*args,**kwargs):
            write(*args,**kwargs);raise OSError('owned phase receipt ACK loss')
        with patch.object(P,'_write_exclusive',side_effect=lost),self.assertRaises(J.OperationCommitUncertain):
            self.owner.begin_prepare(key)
        op=next(iter(self.raw()['operations'].values()));self.assertEqual(op['state'],'PREPARING')
        self.assertTrue((self.f.control/'operations'/('publication-'+op['id']+'.json')).exists())
        with self.assertRaises(ValueError):self.owner.begin_prepare(key)
        self.assertEqual(len(self.raw()['operations']),1)

    def test_late_source_pid_reincarnation_does_not_become_metadata_permission(self):
        key=self.claim();self.owner.begin_prepare(key);self.publish()
        path=self.f.proc/'123/stat';path.write_text(path.read_text().replace('77','78'))
        with self.assertRaises(J.OperationCommitUncertain):self.owner.confirm_publication(key)
        self.assertEqual(next(iter(self.raw()['operations'].values()))['state'],'PREPARING')

    def test_publication_profile_version_drift_keeps_fence(self):
        key=self.claim();self.owner.begin_prepare(key);self.publish()
        f=self.f;snapshot=f.profiles.snapshot();profile=snapshot['profiles'][F.EID]
        f.profiles.put(F.EID,profile['resources'],profile['binding'],expected_revision=snapshot['revision'],
            expected_profile_version=profile['version'],expected_binding=profile['binding'])
        with self.assertRaises(J.OperationCommitUncertain):self.owner.confirm_publication(key)
        with self.assertRaisesRegex(ValueError,'RECONCILIATION'):
            with f.gate.admission(F.APPROVED_TARGET):pass

    def config_fixture(self):
        f=self.f;directory=f.root/'actor-policy';directory.mkdir(mode=0o700)
        path=directory/'worker.json';path.write_bytes(J.encode(f.config));path.chmod(0o600)
        f.native.config_file=path;f.native.lock=threading.RLock()
        name=f.config['deployment']+'-agent-'+F.SID;f.native.laptops={F.SID:name}
        run=f.native.run_engine
        def engine(args,optional=False,*,deadline=None):
            if args==['inspect',name]:return run(['inspect',f.native.rows[0]['Id']],optional)
            return run(args,optional)
        f.native.run_engine=engine
        f.native._reload_resources=types.MethodType(Broker._reload_resources,f.native)
        return path

    def prepared_fixture(self):
        path=self.config_fixture();key=self.claim();self.owner.begin_prepare(key);self.publish()
        self.owner.confirm_publication(key);return path,key

    def test_private_preparation_uses_real_config_cas_reload_and_native_ack_only(self):
        path,key=self.prepared_fixture();before=path.read_bytes();receipt=self.owner._commit_configuration(key)
        self.assertEqual(receipt['state'],'PREPARED_CONFIG_ONLY_SOURCE_UNCHANGED')
        candidate=load_config(path);self.assertEqual(self.f.native.config,candidate)
        self.assertEqual(effective_config(candidate,F.SID)['memoryMiB'],2048)
        self.assertEqual(effective_config(candidate,F.APPROVED_TARGET)['memoryMiB'],4096)
        self.assertEqual(policy_digest(candidate,F.SID),policy_digest(self.f.config,F.SID))
        op=next(iter(self.raw()['operations'].values()));self.assertEqual((op['state'],op['version']),('PREPARED',3))
        self.assertEqual(op['last_receipt_digest'],J.fingerprint(receipt))
        self.assertEqual((self.f.control/'operations'/('config-before-'+op['id']+'.json')).read_bytes(),before)
        self.assertTrue((self.f.control/'operations'/('config-attempt-'+op['id']+'.json')).exists())
        self.assertEqual((self.f.control/'profiles/profiles.json').read_bytes(),self.profile_bytes)
        self.assertTrue(all(args[0] in ('ps','inspect') for args in self.f.native.calls))
        with self.assertRaisesRegex(ValueError,'ALREADY_ATTEMPTED'):self.owner._commit_configuration(key)
        with self.assertRaisesRegex(ValueError,'RECONCILIATION'):
            with self.f.gate.admission(F.APPROVED_TARGET):pass

    def test_regular_reload_has_no_claim_scoped_exception(self):
        path,key=self.prepared_fixture();candidate=self.owner.stage_configuration(key)['config']
        path.write_bytes(J.encode(candidate))
        with self.f.gate.admission(),self.assertRaisesRegex(ValueError,'RECONCILIATION'):
            self.f.native._reload_resources()
        self.assertEqual(self.f.native.config,self.f.config)

    def test_late_config_replacement_refuses_without_rollback_or_retry(self):
        path,key=self.prepared_fixture();custody=self.f.gate.native.custody;calls=[]
        def changed(root,binding):
            value=custody(root,binding)
            if root==path.parent:
                calls.append(True)
                if len(calls)==2:path.write_bytes(path.read_bytes()+b'\n')
            return value
        with patch.object(self.f.gate.native,'custody',new=changed),self.assertRaises(J.OperationCommitUncertain):
            self.owner._commit_configuration(key)
        self.assertGreaterEqual(len(calls),2);self.assertTrue(path.read_bytes().endswith(b'\n'))
        self.assertEqual(next(iter(self.raw()['operations'].values()))['state'],'PREPARING')
        self.assertTrue(list(path.parent.glob('.resource-preparing-*')))
        with self.assertRaises(ValueError):self.owner._commit_configuration(key)

    def test_lost_config_rename_ack_preserves_partial_candidate_and_all_fences(self):
        path,key=self.prepared_fixture();rename=P.os.rename
        def lost(*args,**kwargs):
            result=rename(*args,**kwargs)
            if args[1]==path.name:raise OSError('owned config ACK lost')
            return result
        with patch.object(P.os,'rename',side_effect=lost),self.assertRaises(J.OperationCommitUncertain):
            self.owner._commit_configuration(key)
        self.assertEqual(effective_config(load_config(path),F.APPROVED_TARGET)['memoryMiB'],4096)
        self.assertEqual(self.f.native.config,self.f.config)
        self.assertEqual(next(iter(self.raw()['operations'].values()))['state'],'PREPARING')
        with self.assertRaises(ValueError):self.owner._commit_configuration(key)

    def test_reload_failure_does_not_restore_config_or_release_capacity(self):
        path,key=self.prepared_fixture()
        with patch.object(self.f.native,'_reload_resources',side_effect=RuntimeError('owned reload uncertainty')), \
             self.assertRaises(J.OperationCommitUncertain):self.owner._commit_configuration(key)
        self.assertEqual(effective_config(load_config(path),F.APPROVED_TARGET)['memoryMiB'],4096)
        op=next(iter(self.raw()['operations'].values()));self.assertEqual(op['state'],'PREPARING')
        self.assertEqual(op['delta_bytes'],str(2048*P.J.MIB))
        self.assertTrue((self.f.control/'operations'/('config-attempt-'+op['id']+'.json')).exists())

    def test_journal_prepared_ack_loss_is_not_verified_or_restart_permission(self):
        path,key=self.prepared_fixture();rename=J.os.rename
        def lost(*args,**kwargs):
            result=rename(*args,**kwargs)
            if args[1]=='operations.json':raise OSError('owned PREPARED ACK loss')
            return result
        with patch.object(J.os,'rename',side_effect=lost),self.assertRaises(J.OperationCommitUncertain):
            self.owner._commit_configuration(key)
        self.assertEqual(next(iter(self.raw()['operations'].values()))['state'],'PREPARED')
        cold=P.ResourcePreparationOwner(self.f.native);self.addCleanup(cold.close)
        with self.assertRaises(ValueError):cold.begin_prepare(key)
        with self.assertRaisesRegex(ValueError,'RECONCILIATION'):
            with self.f.gate.admission(F.APPROVED_TARGET):pass

    def test_profile_change_during_last_config_custody_refuses_before_rename(self):
        path,key=self.prepared_fixture();before=path.read_bytes();custody=self.f.gate.native.custody;calls=[]
        def changed(root,binding):
            value=custody(root,binding)
            if root==path.parent:
                calls.append(True)
                if len(calls)==2:
                    snapshot=self.f.profiles.snapshot();profile=snapshot['profiles'][F.EID]
                    self.f.profiles.put(F.EID,profile['resources'],profile['binding'],expected_revision=snapshot['revision'],
                        expected_profile_version=profile['version'],expected_binding=profile['binding'])
            return value
        with patch.object(self.f.gate.native,'custody',new=changed),self.assertRaises(J.OperationCommitUncertain):
            self.owner._commit_configuration(key)
        self.assertEqual(path.read_bytes(),before)
        self.assertEqual(next(iter(self.raw()['operations'].values()))['state'],'PREPARING')

    def test_phase_file_replacement_cannot_reauthorize_intended_publication(self):
        key=self.claim();self.owner.begin_prepare(key);self.publish()
        op=next(iter(self.raw()['operations'].values()));path=self.f.control/'operations'/('publication-'+op['id']+'.json')
        other=path.with_suffix('.owned');other.write_bytes(path.read_bytes());other.chmod(0o600);other.replace(path)
        with self.assertRaises(J.OperationCommitUncertain):self.owner.confirm_publication(key)
        self.assertEqual(next(iter(self.raw()['operations'].values()))['state'],'PREPARING')

    def test_preview_preselects_ids_without_claim_handle_hold_or_profile_change(self):
        path=self.f.control/'operations/operations.json';before=path.read_bytes()
        draft=self.owner.draft(F.EID,F.KEY)
        self.assertFalse(draft['capacityHeld']);self.assertFalse(draft['nativeEffects'])
        self.assertEqual(path.read_bytes(),before);self.assertEqual(self.owner._claims,{})
        self.assertEqual((self.f.control/'profiles/profiles.json').read_bytes(),self.profile_bytes)
        self.owner.close();self.assertEqual(path.read_bytes(),before)
        self.assertIsNone(self.f.gate.inspect(F.KEY))

    def test_apply_consumes_exact_preapproved_ids_with_no_after_approval_allocation(self):
        draft=self.owner.draft(F.EID,F.KEY)
        with patch.object(J.uuid,'uuid4',side_effect=AssertionError('no replacement of approved IDs')):
            result=self.owner.reserve(draft['draftId'],draft['previewDigest'])
        op=result['operation']['operation']
        self.assertEqual((op['id'],op['reservation_id'],op['reserved_sid']),
                         (draft['operationId'],draft['reservationId'],draft['targetSid']))
        self.assertEqual(op['request']['preview_digest'],draft['previewDigest'])

    def test_changed_preview_digest_cannot_create_a_positive_hold(self):
        draft=self.owner.draft(F.EID,F.KEY);before=self.raw()
        with self.assertRaisesRegex(ValueError,'DRAFT_CHANGED'):
            self.owner.reserve(draft['draftId'],'a'*64)
        self.assertEqual(self.raw(),before);self.assertEqual(self.owner._claims,{})

    def test_profile_change_after_preview_refuses_apply_without_claim(self):
        draft=self.owner.draft(F.EID,F.KEY);f=self.f;snapshot=f.profiles.snapshot();profile=snapshot['profiles'][F.EID]
        f.profiles.put(F.EID,profile['resources'],profile['binding'],expected_revision=snapshot['revision'],
            expected_profile_version=profile['version'],expected_binding=profile['binding'])
        with self.assertRaisesRegex(ValueError,'DRAFT_CHANGED'):self.owner.reserve(draft['draftId'],draft['previewDigest'])
        self.assertEqual(self.raw()['operations'],{})

    def late_policy_mutation(self,mode):
        import inspect
        path,key=self.prepared_fixture();f=self.f;custody=f.gate.native.custody;changed=[]
        def late(root,binding):
            result=custody(root,binding)
            in_ack=inspect.currentframe().f_back.f_code.co_name=='_ack_policy_current'
            if 'employeeResources' in f.native.config and not changed and (mode!='ack' or in_ack):
                if mode=='same-bytes-replace':
                    other=path.with_suffix('.owned-replacement');other.write_bytes(path.read_bytes())
                    other.chmod(0o600);other.replace(path)
                else:
                    value=json.loads(path.read_bytes());value['poolMemoryMiB']+=1024;path.write_bytes(J.encode(value))
                changed.append(True)
            return result
        with patch.object(f.gate.native,'custody',new=late),self.assertRaises(J.OperationCommitUncertain):
            self.owner._commit_configuration(key)
        self.assertTrue(changed)
        op=next(iter(self.raw()['operations'].values()))
        self.assertEqual(op['state'],'PREPARING');self.assertIsNone(op['last_receipt_digest'])
        self.assertTrue((f.control/'operations'/('config-attempt-'+op['id']+'.json')).exists())
        self.assertTrue((f.control/'operations'/('config-before-'+op['id']+'.json')).exists())
        self.assertTrue(all(args[0] in ('ps','inspect') for args in f.native.calls))
        with self.assertRaises(ValueError):self.owner._commit_configuration(key)
        return path

    def test_actual_policy_drift_during_native_custody_after_reload_never_acks_prepared(self):
        path=self.late_policy_mutation('after-reload')
        self.assertEqual(load_config(path)['poolMemoryMiB'],9216)
        self.assertEqual(self.f.native.config['poolMemoryMiB'],8192)

    def test_actual_policy_drift_during_record_ack_scope_guard_refuses_before_ack_commit(self):
        self.late_policy_mutation('ack')

    def test_same_bytes_new_policy_inode_after_reload_is_not_fresh_preparation(self):
        self.late_policy_mutation('same-bytes-replace')
