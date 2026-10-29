"""Real durable stores/fences; controlled native AND owner-readiness ports.

This isolates settlement/fault mechanics. The real cookie/channel producer has
separate IPC controls; these fixtures are not native/owner acceptance evidence.
"""
import copy
import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch

from reverie import laptop_resource_operations as J
from reverie import worker_resource_native as N
from reverie import worker_resource_actor as A
from reverie import worker_resource_finalization as S
from tests import test_worker_resource_canonical_launch as C
from tests import test_worker_resource_reservations as F
from tests.test_resource_actor_install import model_nix_fixture_ancestry


class ResourceFinalization(unittest.TestCase):
    def setUp(self):
        self.case=C.CanonicalResourceLaunch();self.case.setUp();self.addCleanup(self.case.doCleanups)
        self.owner,self.key,self.f=self.case.owner,self.case.native.key,self.case.f
        self.case.run_request();self.claim=self.owner._current(self.key);self.lease=self.claim['lease']
        N.acknowledge_started(self.owner,self.key);N.begin_verification(self.owner,self.key)
        op=self.lease.view['operation'];profile=self.lease.context['profile']
        self.record={'id':op['id'],'employeeId':F.EID,'oldSession':F.SID,'newSession':F.APPROVED_TARGET,
            'phase':'checking','resourcePhase':'verifying','owner':'fixture-owner','sourceStopRequested':True,
            'sourceCleanupVerified':True,'purpose':'runtime-refresh','fromAccount':'same','toAccount':'same',
            'runtimeDigest':'a'*64,'requestDigest':'b'*64,'resourceOwnerScope':'c'*64,
            'resourceIntent':{'operationId':op['id'],'reservationId':op['reservation_id'],
              'profileVersion':str(profile['version']),'profileDigest':J.fingerprint(profile),
              'previewDigest':op['request']['preview_digest']}}
        self.connection=A._Connection.__new__(A._Connection);self.connection.owner=self.owner
        self.selected={'key':self.key}
        def observe(_selected,stage):
            proof={'sessionId':F.APPROVED_TARGET,'mode':'codex','pid':321,'panePid':654,'muxName':'own-controlled-pane',
                'readyMarker':'? for shortcuts','normalReadyObservedAt':1,
                'recipeDigest':'d'*64,'recordDigest':J.fingerprint(self.record)}
            return proof,copy.deepcopy(self.record)
        # Fixed typed producer's observation port only. No engine or current
        # human auth is inferred from these synthetic values.
        self.connection.check_readiness=observe
        proof,record=observe(self.selected,'verify')
        verified=A._ReadinessProof(A._MINT,self.connection,self.selected,'verify',proof,record)
        self.claim['readiness_proof']=verified;N.acknowledge_verified(self.owner,self.key,verified)
        self.record.update(phase='completed',resourcePhase='verified')
        proof,record=observe(self.selected,'finalize')
        self.proof=A._ReadinessProof(A._MINT,self.connection,self.selected,'finalize',proof,record)
        self.claim['final_readiness']=self.proof
        self.opid=op['id'];self.pending=self.f.control/'operations'/('settlement-'+self.opid+'.pending.json')
        model_nix_fixture_ancestry(self)
    def raw(self):return self.case.native.case.raw()['operations'][self.opid]

    def test_actual_native_terminal_transition_then_all_finalizers_then_last_fence_release(self):
        result=S.complete(self.owner,self.key,self.proof)
        self.assertEqual(result,{'state':'COMPLETED_NATIVE_SETTLED','operationId':self.opid,
                                  'capacityRetained':False,'retryAllowed':False})
        self.assertEqual((self.raw()['state'],self.raw()['version']),('COMPLETED',8))
        self.assertFalse(self.pending.exists());self.assertTrue(self.lease.closed)
        with self.owner.gate.admission():
            self.assertEqual(self.owner.gate.active_operations(self.owner.gate._document()),[])
            self.owner.gate.check_launch(F.APPROVED_TARGET)
        with self.assertRaises(ValueError):S.complete(self.owner,self.key,self.proof)

    def test_hash_or_serialized_receipt_is_never_a_native_completion_producer(self):
        with self.owner.gate.admission(),self.assertRaises(ValueError):
            self.lease.store.complete_native(self.owner.gate.scope,self.lease.handle,{'digest':'e'*64},expected_version=7)
        self.assertEqual(self.raw()['state'],'VERIFY_RECORDED');self.assertFalse(self.pending.exists())

    def test_store_close_failure_retains_pending_even_after_durable_completed_record(self):
        close=self.lease.close
        def fault():close();raise OSError('owned terminal descriptor close failure')
        with patch.object(self.lease,'close',side_effect=fault),self.assertRaises(J.OperationCommitUncertain):
            S.complete(self.owner,self.key,self.proof)
        self.assertEqual(self.raw()['state'],'COMPLETED');self.assertTrue(self.pending.exists())
        with self.owner.gate.admission(),self.assertRaisesRegex(ValueError,'RECONCILIATION'):
            self.owner.gate.check_launch(F.APPROVED_TARGET)

    def test_late_directory_rebinding_does_not_clear_either_old_or_replacement_pending_marker(self):
        metadata=S._metadata
        def replace(gate):
            metadata(gate);path=gate.root/'operations';preserved=gate.root/'operations-retained'
            path.rename(preserved);shutil.copytree(preserved,path)
        with patch.object(S,'_metadata',side_effect=replace),self.assertRaises(J.OperationCommitUncertain):
            S.complete(self.owner,self.key,self.proof)
        self.assertTrue(self.pending.exists())
        self.assertTrue((self.f.control/'operations-retained'/self.pending.name).exists())

    def test_final_unlink_refusal_keeps_fence_and_cold_cannot_authorize_replay(self):
        unlink=S.os.unlink
        def refused(path,*args,**kwargs):
            if Path(path)==self.pending:raise OSError('owned last unlink refusal')
            return unlink(path,*args,**kwargs)
        with patch.object(S.os,'unlink',side_effect=refused),self.assertRaises(J.OperationCommitUncertain):
            S.complete(self.owner,self.key,self.proof)
        self.assertEqual(self.raw()['state'],'COMPLETED');self.assertTrue(self.pending.exists())
        self.assertTrue(self.lease.closed)
        with self.owner.gate.admission(),self.assertRaisesRegex(ValueError,'RECONCILIATION'):
            self.owner.gate.check_launch(F.APPROVED_TARGET)

    def test_missing_historical_native_receipt_refuses_instead_of_treating_json_completed_as_credit(self):
        S.complete(self.owner,self.key,self.proof)
        (self.f.control/'operations'/('settled-'+self.opid+'.json')).unlink()
        with self.owner.gate.admission(),self.assertRaises((OSError,ValueError)):
            self.owner.gate.check_launch(F.APPROVED_TARGET)

    def test_vacation_during_actual_store_close_keeps_pending_and_uncertainty(self):
        close=self.lease.close;path=Path(self.f.config['companyFile'])
        def changed():
            close();company=json.loads(path.read_text());company['employees'][0]['onVacation']=True
            path.write_text(json.dumps(company))
        with patch.object(self.lease,'close',side_effect=changed),self.assertRaises(J.OperationCommitUncertain):
            S.complete(self.owner,self.key,self.proof)
        self.assertTrue(self.pending.exists());self.assertEqual(self.raw()['state'],'COMPLETED')

    def test_profile_change_during_actual_store_close_does_not_clear_pending(self):
        close=self.lease.close;changed=False
        def mutation():
            nonlocal changed
            close()
            if not changed:
                changed=True;snapshot=self.f.profiles.snapshot();p=snapshot['profiles'][F.EID]
                self.f.profiles.put(F.EID,p['resources'],p['binding'],expected_revision=snapshot['revision'],
                    expected_profile_version=p['version'],expected_binding=p['binding'])
        with patch.object(self.lease,'close',side_effect=mutation),self.assertRaises(J.OperationCommitUncertain):
            S.complete(self.owner,self.key,self.proof)
        self.assertTrue(changed);self.assertTrue(self.pending.exists())

    def test_orphan_pending_after_journal_loss_remains_a_cold_creation_fence(self):
        close=self.lease.close;path=self.f.control/'operations/operations.json';changed=False
        def mutation():
            nonlocal changed
            close()
            if not changed:
                changed=True;document=json.loads(path.read_text());document['revision']+=1;document['operations']={}
                path.write_text(json.dumps(document))
        with patch.object(self.lease,'close',side_effect=mutation),self.assertRaises(J.OperationCommitUncertain):
            S.complete(self.owner,self.key,self.proof)
        self.assertTrue(self.pending.exists())
        with self.owner.gate.admission(),self.assertRaisesRegex(ValueError,'ORPHAN_PENDING'):
            self.owner.gate.check_launch(F.APPROVED_TARGET)

    def test_later_metadata_read_cannot_hide_an_earlier_profile_file_change(self):
        from reverie import worker_storage
        read=worker_storage.read_metadata;company_path=Path(self.f.config['companyFile']);changed=False
        def mutation(path,*args,**kwargs):
            nonlocal changed
            result=read(path,*args,**kwargs)
            if self.lease.closed and not changed and Path(path)==company_path:
                changed=True;snapshot=self.f.profiles.snapshot();p=snapshot['profiles'][F.EID]
                self.f.profiles.put(F.EID,p['resources'],p['binding'],expected_revision=snapshot['revision'],
                    expected_profile_version=p['version'],expected_binding=p['binding'])
            return result
        with patch.object(worker_storage,'read_metadata',side_effect=mutation),self.assertRaises(J.OperationCommitUncertain):
            S.complete(self.owner,self.key,self.proof)
        self.assertTrue(changed);self.assertTrue(self.pending.exists())

    def test_unchanged_leaf_inodes_through_late_parent_symlink_do_not_clear_pending(self):
        from reverie import worker_storage
        read=worker_storage.read_metadata;company_path=Path(self.f.config['companyFile']);changed=False
        original=(self.f.control/'profiles/profiles.json').stat()
        def mutation(path,*args,**kwargs):
            nonlocal changed
            result=read(path,*args,**kwargs)
            if self.lease.closed and not changed and Path(path)==company_path:
                changed=True;directory=self.f.control/'profiles';retained=self.f.control/'profiles-retained'
                directory.rename(retained);directory.symlink_to(retained,target_is_directory=True)
            return result
        with patch.object(worker_storage,'read_metadata',side_effect=mutation),self.assertRaises(J.OperationCommitUncertain):
            S.complete(self.owner,self.key,self.proof)
        self.assertTrue(changed);self.assertTrue(self.pending.exists())
        current=(self.f.control/'profiles/profiles.json').stat()
        self.assertEqual((original.st_dev,original.st_ino),(current.st_dev,current.st_ino))
