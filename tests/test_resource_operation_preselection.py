"""Protected ID preselection under the existing real durable journal lock."""
import copy
import fcntl
import os
import unittest
from unittest.mock import patch

from reverie import laptop_resource_operations as J
from tests import test_laptop_resource_operations as F

OP='71234567-1234-4123-8123-123456789abc'
RES='81234567-1234-4123-8123-123456789abc'
TARGET='33333333-3333-4333-8333-333333333333'


class Preselection(unittest.TestCase):
    def setUp(self):
        self.f=F.Operations();self.f.setUp();self.addCleanup(self.f.tearDown)

    def claim(self,**overrides):
        args={'operation_id':OP,'reservation_id':RES,'reserved_sid':TARGET};args.update(overrides)
        return self.f.store.claim(F.SCOPE,F.KEY,F.proposal(),**args)

    def test_exact_ids_persist_and_explicit_or_omitted_replay_never_mints_handle(self):
        view,handle=self.claim();self.assertIsNotNone(handle)
        self.assertEqual((view['operation']['id'],view['operation']['reservation_id'],view['operation']['reserved_sid']),
                         (OP,RES,TARGET))
        before=self.f.raw()
        for options in ({},{'operation_id':OP,'reservation_id':RES,'reserved_sid':TARGET}):
            again,replay=self.f.store.claim(F.SCOPE,F.KEY,F.proposal(),**options)
            self.assertIsNone(replay);self.assertEqual(again['operation']['id'],OP)
        for field in ('operation_id','reservation_id','reserved_sid'):
            with self.subTest(field=field),self.assertRaisesRegex(J.OperationRefusal,'IDEMPOTENCY_CONFLICT'):
                self.claim(**{field:'44444444-4444-4444-8444-444444444444'})
        self.assertEqual(self.f.raw(),before)

    def test_canonical_role_checks_are_under_real_flock_and_bad_roles_leave_no_claim(self):
        canonical=J.canonical_uuid;checked=[]
        def under_lock(value):
            if value in (OP,RES):
                fd=os.open(self.f.root/'operations.lock',os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                finally:os.close(fd)
                checked.append(value)
            return canonical(value)
        with patch.object(J,'canonical_uuid',new=under_lock):self.claim()
        self.assertTrue(checked)
        for field,value in [('operation_id',F.SID),('reservation_id',F.SID),('reservation_id',OP)]:
            # Separate owned store so the duplicate-key replay path cannot mask roles.
            other=F.Operations();other.setUp()
            try:
                args={'operation_id':OP,'reservation_id':RES,'reserved_sid':TARGET};args[field]=value
                with self.assertRaises(J.OperationRefusal):other.store.claim(F.SCOPE,F.KEY,F.proposal(),**args)
                self.assertEqual(other.raw()['operations'],{})
            finally:other.tearDown()

    def test_retained_operation_reservation_or_transport_collision_never_overwrites(self):
        self.claim();before=self.f.raw();request=F.proposal(F.observed(F.OTHER_EMPLOYEE),requested=40)
        for field,existing in [('operation_id',OP),('operation_id',RES),('operation_id',TARGET),
                               ('reservation_id',OP),('reservation_id',RES),('reservation_id',F.SID)]:
            args={'operation_id':'44444444-4444-4444-8444-444444444444',
                  'reservation_id':'55555555-5555-4555-8555-555555555555',
                  'reserved_sid':'66666666-6666-4666-8666-666666666666'};args[field]=existing
            with self.subTest(field=field,role=existing),self.assertRaises(J.OperationRefusal):
                self.f.store.claim(F.SCOPE,F.OTHER_KEY,request,**args)
            self.assertEqual(self.f.raw(),before)

    def test_selected_commit_ack_loss_retains_exact_ids_without_reopenable_handle(self):
        rename=J.os.rename
        def lost(*args,**kwargs):
            result=rename(*args,**kwargs)
            if args[1]=='operations.json':raise OSError('owned selected allocation ACK loss')
            return result
        with patch.object(J.os,'rename',side_effect=lost),self.assertRaises(J.OperationCommitUncertain):self.claim()
        op=self.f.raw()['operations'][OP]
        self.assertEqual((op['reservation_id'],op['reserved_sid']),(RES,TARGET))
        view,replay=self.claim();self.assertIsNone(replay)
        self.assertEqual(view['operation']['state'],'RECOVERY_REQUIRED')
