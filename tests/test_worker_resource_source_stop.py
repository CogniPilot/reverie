"""SourceStopRequested/supervisor interleaving; owned files, no native engine."""
import json
import threading
import types
import unittest
import runpy
from unittest.mock import patch

from reverie.worker import Broker
from reverie import laptop_resource_operations as J
from reverie import worker_resource_reservations as R
from tests import test_worker_resource_native as T
from tests import test_worker_resource_reservations as F


class SourceStopFence(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(Broker, 'run_engine', side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')))
        self.case = T.NativeStart(); self.case.setUp(); self.addCleanup(self.case.doCleanups)

    def test_standalone_broker_module_resolves_the_protected_process_reader(self):
        import reverie.worker as worker
        namespace = runpy.run_path(worker.__file__, run_name='_standalone_worker_source_fixture')
        standalone = namespace['Broker']
        c = self.case
        c.f.native.stop = types.MethodType(standalone.stop, c.f.native)
        permit = c.begin()
        result = c.owner._stop_source_once(c.key, permit)
        self.assertEqual(result['state'], 'SOURCE_RELEASED_TARGET_NOT_CREATED')
        self.assertEqual([args[0] for args in c.effects], ['stop'])

    def test_exact_cid_pid_arguments_alone_do_not_replace_the_registered_operation_permit(self):
        c = self.case; row = c.f.native.rows[0]
        with self.assertRaisesRegex(ValueError, 'STOP_REQUIRES_PROTECTED'):
            c.f.native.stop(row['Name'].removeprefix('/'), expected_id=row['Id'],
                            expected_process={'pid': 123, 'start': '77'}, retain_storage=True)
        self.assertEqual(c.effects, [])
        self.assertIn(F.SID, c.f.native.storage_leases)

    def test_supervisor_then_protected_stop_never_kills_observed_new_incarnation(self):
        c = self.case; f = c.f
        permit = c.begin()
        op = c.case.raw()['operations'][permit.operation_id]
        self.assertEqual(op['state'], 'STARTING')
        plan = {'oldSession': F.SID, 'newSession': F.APPROVED_TARGET,
                'phase': 'stopping', 'sourceStopRequested': True}
        from pathlib import Path
        Path(f.config['companyFile']).with_name('plan-moves.json').write_text(json.dumps([plan]))
        old = f.native.rows[0]; old['State'] = {'Running': True, 'Pid': 125}
        f.kernel(old); (f.proc/'123/stat').unlink()
        name = old['Name'].removeprefix('/')
        f.native.allowed = types.MethodType(Broker.allowed, f.native)
        f.native.lock = threading.RLock(); f.native.laptops = {F.SID: name}
        f.native.active = {}; f.native.offices = {}; f.native.address = lambda: '127.0.0.1'
        waits = iter([False, True])
        original_stopping = f.native.stopping
        f.native.stopping = types.SimpleNamespace(wait=lambda _timeout: next(waits), deadline=None)
        try:
            with patch('reverie.worker.http.client.HTTPConnection', side_effect=OSError('controlled offline')):
                Broker.supervise(f.native)
        finally:
            f.native.stopping = original_stopping
        self.assertEqual(c.effects, [])
        self.assertEqual(R._pid(125), '77')
        with self.assertRaises(J.OperationCommitUncertain):
            c.owner._stop_source_once(c.key, permit)
        self.assertEqual(c.effects, [])
        self.assertIn(F.SID, f.native.storage_leases)
        raw = c.case.raw()['operations'][permit.operation_id]
        self.assertEqual(raw['state'], 'STARTING')
        self.assertEqual(raw['delta_bytes'], str(2048*J.MIB))
        self.assertEqual(R._pid(125), '77')
        # A controller restart has no process-local claim or implicit cleanup
        # permission. The same durable journal continues to fence legacy stop.
        f.native.resource_reservations = R.ReservationGate(f.native)
        with self.assertRaisesRegex(ValueError, 'STOP_REQUIRES_PROTECTED'):
            f.native.stop(name)
        self.assertEqual(c.effects, [])
