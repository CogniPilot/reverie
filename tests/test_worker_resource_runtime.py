"""Real journal/leases and controlled canonical native ports; no engine/CLI."""
import copy
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from reverie import laptop_resource_operations as J
from reverie import worker_resource_native as N
from tests import test_worker_resource_canonical_launch as C
from tests import test_worker_resource_reservations as F


class ResourceRuntimeJournal(unittest.TestCase):
    def setUp(self):
        # Its setUp installs REAL_ENGINE_FORBIDDEN before Broker/observer/gate
        # construction, then supplies only fixed controlled native operations.
        self.case=C.CanonicalResourceLaunch();self.case.setUp();self.addCleanup(self.case.doCleanups)
        self.owner,self.key=self.case.owner,self.case.native.key
        self.case.run_request()
        self.claim=self.owner._current(self.key);self.lease=self.claim['lease']
        self.assertTrue(self.claim['canonical_released'])
    def raw(self):return self.case.native.case.raw()['operations'][self.case.permit.operation_id]

    def test_start_ack_requires_real_canonical_release_and_retains_capacity(self):
        result=N.acknowledge_started(self.owner,self.key)
        self.assertEqual(result['state'],'STARTED_READINESS_NOT_VERIFIED')
        self.assertTrue(result['capacityRetained']);self.assertEqual((self.raw()['state'],self.raw()['version']),('STARTED',5))
        self.assertEqual(self.raw()['delta_bytes'],str(2048*J.MIB))
        self.assertIn(F.APPROVED_TARGET,self.case.broker.storage_leases)
        with self.assertRaises(ValueError):N.acknowledge_started(self.owner,self.key)

    def test_old_creation_permit_cannot_be_reused_after_started_and_cold_lookup_is_not_a_runtime_permit(self):
        N.acknowledge_started(self.owner,self.key)
        with self.owner.gate.admission(),self.assertRaisesRegex(ValueError,'PERMIT_CHANGED'):
            N.observe_created(self.owner.gate,self.case.permit)
        with self.owner.gate.admission(),self.assertRaisesRegex(ValueError,'RECONCILIATION'):
            self.owner.gate.check_launch(F.APPROVED_TARGET)
        from dataclasses import replace
        copied=replace(self.claim['runtime_permit'])
        with self.owner.gate.admission(),self.assertRaisesRegex(ValueError,'PERMIT_CHANGED'):
            N.observe_created(self.owner.gate,copied)

    def test_verification_intent_is_durable_before_readiness_and_gives_no_credit(self):
        N.acknowledge_started(self.owner,self.key)
        self.assertEqual(N.begin_verification(self.owner,self.key),{'state':'VERIFYING','capacityRetained':True})
        self.assertEqual((self.raw()['state'],self.raw()['version']),('VERIFYING',6))
        self.assertEqual(self.raw()['delta_bytes'],str(2048*J.MIB))
        self.assertEqual(self.claim['runtime_permit'].version,6)
        with self.assertRaisesRegex(ValueError,'ALREADY_ATTEMPTED'):N.begin_verification(self.owner,self.key)

    def test_process_change_after_actual_journal_temp_fsync_refuses_ack_and_keeps_hold(self):
        fsync=J.os.fsync;changed=False
        def late(fd):
            nonlocal changed
            fsync(fd)
            if not changed and Path(os.readlink('/proc/self/fd/'+str(fd))).name.startswith('.operation-'):
                changed=True;row=self.case.broker.rows[-1];row['State']['Pid']=126;self.case.f.kernel(row)
        with patch.object(J.os,'fsync',side_effect=late),self.assertRaises(J.OperationCommitUncertain):
            N.acknowledge_started(self.owner,self.key)
        self.assertTrue(changed);self.assertEqual(self.raw()['state'],'STARTING')
        self.assertEqual(self.raw()['delta_bytes'],str(2048*J.MIB));self.assertTrue(self.lease.closed)
        self.assertIn(F.APPROVED_TARGET,self.case.broker.storage_leases)

    def test_rename_ack_loss_keeps_actual_started_record_and_never_retries_or_credits(self):
        rename=J.os.rename
        def lost(source,target,*args,**kwargs):
            rename(source,target,*args,**kwargs)
            if target=='operations.json':raise OSError('owned journal rename acknowledgement loss')
        with patch.object(J.os,'rename',side_effect=lost),self.assertRaises(J.OperationCommitUncertain):
            N.acknowledge_started(self.owner,self.key)
        self.assertEqual(self.raw()['state'],'STARTED');self.assertTrue(self.lease.closed)
        self.assertEqual(self.raw()['delta_bytes'],str(2048*J.MIB))
        with self.assertRaises(ValueError):N.acknowledge_started(self.owner,self.key)
        self.assertIn(F.APPROVED_TARGET,self.case.broker.storage_leases)
