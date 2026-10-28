"""Canonical settled stores and controlled native/owner ports; no engine effects."""
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
import tempfile
from unittest.mock import patch

from reverie import worker_resource_actor as A
from reverie import worker_resource_reconciliation as H
from reverie import worker_resource_finalization as S
from reverie import worker_resource_reservations as R
from reverie.worker import Broker
from tests import test_worker_resource_finalization as F
from tests import test_worker_resource_reservations as V


class HistoricalCompletion(unittest.TestCase):
    def setUp(self):
        # The inherited setup installs REAL_ENGINE_FORBIDDEN before constructing
        # any Broker/observer, then injects only its closed synthetic native ABI.
        self.case=F.ResourceFinalization();self.case.setUp();self.addCleanup(self.case.doCleanups)
        self.gate=self.case.owner.gate;self.broker=self.gate.broker
        self.connection=A._Connection.__new__(A._Connection);self.connection.broker=self.broker
        self.authority=A._OwnerOperation(A._MINT,self.connection,V.EID,None)
        self.authority.owner='fixture-owner'
        self.enterContext(patch.object(self.authority,'assert_current'))
        self.enterContext(patch.object(self.authority,'assert_live'))
        self.plan=Path(self.broker.config['companyFile']).with_name('plan-moves.json')
        self.plan.write_text(json.dumps([self.case.record]));self.plan.chmod(0o600)
    def settle(self):
        S.complete(self.case.owner,self.case.key,self.case.proof)
        self.before=(self.gate.root/'operations/operations.json').read_bytes()
        self.case.owner.close()  # No executing handle survives to inspection.
    def inspect(self):return H.inspect_completion(self.gate,self.authority,self.case.opid)
    def test_settled_restart_reads_real_receipts_and_fresh_native_facts_without_handle_or_writes(self):
        self.settle()
        cold=R.ReservationGate(self.broker);self.gate=cold
        result=self.inspect()
        self.assertEqual(result['state'],'HISTORICAL_NATIVE_SETTLEMENT_CONFIRMED')
        self.assertEqual((result['employeeId'],result['targetSid'],result['readOnly']),(V.EID,V.APPROVED_TARGET,True))
        self.assertEqual((cold.root/'operations/operations.json').read_bytes(),self.before)
        self.assertFalse(self.case.pending.exists());self.assertTrue(self.case.lease.closed)
    def test_nonterminal_cannot_be_recognized_by_plan_json_alone(self):
        with self.assertRaisesRegex(ValueError,'SETTLED_OPERATION_REQUIRED'):self.inspect()
        self.assertEqual(self.case.raw()['state'],'VERIFY_RECORDED')
    def test_pending_and_missing_canonical_receipt_refuse_without_repair(self):
        self.settle();pending=self.case.pending
        pending.write_text(json.dumps({'schema':'reverie-resource-settlement-pending-v1',
            'operationId':self.case.opid,'reservationId':self.case.raw()['reservation_id'],
            'verifiedReceiptDigest':'a'*64}));pending.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'SETTLED_OPERATION_REQUIRED'):self.inspect()
        self.assertTrue(pending.exists())
    def test_missing_historical_receipt_is_unknown_not_completion(self):
        self.settle();path=self.gate.root/'operations'/('verified-'+self.case.opid+'.json');path.unlink()
        with self.assertRaises(FileNotFoundError):self.inspect()
        self.assertEqual((self.gate.root/'operations/operations.json').read_bytes(),self.before)
    def test_last_native_inventory_target_change_refuses(self):
        self.settle();guard=self.gate._guard;count=0
        def changed(*args,**kwargs):
            nonlocal count
            rows=guard(*args,**kwargs);count+=1
            if count==3:
                row=copy.deepcopy(rows[-1]);row['State']['Pid']=126
                return rows[:-1]+[row]
            return rows
        with patch.object(self.gate,'_guard',side_effect=changed),self.assertRaisesRegex(ValueError,'NATIVE_CHANGED'):
            self.inspect()
        self.assertFalse(self.case.pending.exists())
    def test_company_drift_during_last_native_work_refuses(self):
        self.settle();guard=self.gate._guard;count=0;path=Path(self.broker.config['companyFile'])
        def changed(*args,**kwargs):
            nonlocal count
            rows=guard(*args,**kwargs);count+=1
            if count==3:
                data=json.loads(path.read_text());data['employees'][0]['onVacation']=True;path.write_text(json.dumps(data))
            return rows
        with patch.object(self.gate,'_guard',side_effect=changed),self.assertRaises(ValueError):self.inspect()
        self.assertEqual((self.gate.root/'operations/operations.json').read_bytes(),self.before)
    def test_owner_expiry_during_native_observation_refuses(self):
        self.settle();capacity=self.gate.native.capacity
        def expired(*args):
            result=capacity(*args);self.authority.assert_live.side_effect=ValueError('OWNER_ENDED');return result
        with patch.object(self.gate.native,'capacity',side_effect=expired),self.assertRaisesRegex(ValueError,'OWNER_ENDED'):
            self.inspect()
    def test_late_admission_close_metadata_drift_refuses(self):
        self.settle();close=R.os.close;path=Path(self.broker.config['companyFile']);changed=False
        def late(fd):
            nonlocal changed
            admission=fd==getattr(self.gate._local,'fd',None) and not getattr(self.gate._local,'depth',0)
            close(fd)
            if admission and not changed:
                changed=True;data=json.loads(path.read_text());data['employees'][0]['onVacation']=True
                path.write_text(json.dumps(data))
        with patch.object(R.os,'close',side_effect=late),self.assertRaisesRegex(ValueError,'METADATA_CHANGED'):self.inspect()
        self.assertTrue(changed)

    def test_journal_loss_during_admission_close_does_not_recognize_history(self):
        self.settle();close=R.os.close;path=self.gate.root/'operations/operations.json';changed=False
        def late(fd):
            nonlocal changed
            admission=fd==getattr(self.gate._local,'fd',None) and not getattr(self.gate._local,'depth',0)
            close(fd)
            if admission and not changed:
                changed=True;data=json.loads(path.read_text());data['operations']={};data['revision']+=1
                path.write_text(json.dumps(data))
        with patch.object(R.os,'close',side_effect=late),self.assertRaisesRegex(ValueError,'METADATA_CHANGED'):self.inspect()
        self.assertTrue(changed);self.assertFalse(self.case.pending.exists())

    def test_profile_change_during_last_native_inventory_refuses(self):
        self.settle();guard=self.gate._guard;count=0
        def changed(*args,**kwargs):
            nonlocal count
            rows=guard(*args,**kwargs);count+=1
            if count==3:
                snapshot=self.case.f.profiles.snapshot();profile=snapshot['profiles'][V.EID]
                self.case.f.profiles.put(V.EID,profile['resources'],profile['binding'],
                    expected_revision=snapshot['revision'],expected_profile_version=profile['version'],
                    expected_binding=profile['binding'])
            return rows
        with patch.object(self.gate,'_guard',side_effect=changed),self.assertRaisesRegex(ValueError,'PROFILE_CHANGED'):self.inspect()


class LazyActorFacts(unittest.TestCase):
    def test_missing_or_stale_actor_facts_do_not_strand_existing_recovery_or_phones(self):
        self.enterContext(patch.object(Broker,'run_engine',side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')))
        initialize=V.NativeFixture.__init__
        def configure(selected,config):
            config['resourceActorConfig']=str(Path(config['resourceReservations']['directory'])/'resource-actor.json')
            initialize(selected,config)
        self.enterContext(patch.object(V.NativeFixture,'__init__',configure))
        case=V.Reservations();case.setUp();self.addCleanup(case.doCleanups)
        policy=case.root/'broker-policy.json';policy.write_text(json.dumps(case.config));policy.chmod(0o600)
        with patch.object(Broker,'run_engine',side_effect=case.native.run_engine):
            broker=Broker(case.config,config_file=str(policy))
            self.assertIs(type(broker.resource_actor),A.ResourceActorService)
            office=SimpleNamespace(close=lambda:None)
            with patch.object(broker,'claim_storage',return_value=(SimpleNamespace(kind='session'),False)),\
                 patch('reverie.worker.OfficeAPI',return_value=office) as phone:
                broker.recover()
                self.assertIn(V.SID,broker.laptops);phone.assert_called_once()
            with self.assertRaises(FileNotFoundError):broker.resource_actor.accept(None,(1,2,3))
            with patch('reverie.resource_actor_install.InstalledFacts',side_effect=ValueError('OLD_INCARNATION')):
                with patch.object(broker,'claim_storage',return_value=(SimpleNamespace(kind='session'),False)):
                    broker.recover()  # Existing phone retained; no actor constructor.
                with self.assertRaisesRegex(ValueError,'OLD_INCARNATION'):broker.resource_actor.accept(None,(1,2,3))
        self.assertFalse(Path(case.config['resourceActorConfig']).exists())

    def test_old_launch_uses_its_original_connection_facts(self):
        service=A.ResourceActorService(SimpleNamespace())
        old=SimpleNamespace(guard=unittest.mock.Mock(side_effect=ValueError('OLD_FACTS_STALE')))
        connection=SimpleNamespace(closed=SimpleNamespace(is_set=lambda:False),bootstrap=old,
            owner=SimpleNamespace(_current=lambda key:{}))
        reference='12345678-1234-4234-8234-123456789abc'
        service._launches[reference]=(connection,object(),None)
        with self.assertRaisesRegex(ValueError,'OLD_FACTS_STALE'):
            service.resolve_launch(reference,{},(1,2,3))
        old.guard.assert_called_once()

    def test_same_bytes_private_facts_replacement_or_pending_fences_an_existing_context(self):
        from reverie.goal_private import fingerprint
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);path=root/'resource-actor.json';path.write_text('{}');path.chmod(0o600)
            bootstrap=A.ResourceActorBootstrap.__new__(A.ResourceActorBootstrap)
            bootstrap.path=path;bootstrap.gate=SimpleNamespace(root=root)
            bootstrap.broker=SimpleNamespace(config={'uid':os.getuid(),'resourceActorConfig':str(path)})
            bootstrap.signature=fingerprint(path.lstat())
            bootstrap.parents={parent:bootstrap._directory_stamp(parent) for parent in path.parents}
            bootstrap.assert_metadata()
            marker=root/'resource-actor.installing.json';marker.write_text('{}')
            with self.assertRaisesRegex(ValueError,'PENDING'):bootstrap.assert_metadata()
            marker.unlink();replacement=root/'new-facts.json';replacement.write_text('{}');replacement.chmod(0o600)
            replacement.replace(path)
            with self.assertRaisesRegex(ValueError,'FACTS_CHANGED'):bootstrap.assert_metadata()
