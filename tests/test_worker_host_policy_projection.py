"""Host callback policy is neither a worker grant nor a reason to restart peers."""
import copy
import importlib.util
import unittest
from unittest.mock import patch
from reverie.worker import Broker, create_args
from reverie.worker_resources import resource_config, effective_config, policy_digest, validate_resource_reload
from reverie.cleanup import peer_port
from tests import test_worker as F


class HostPolicyProjection(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(Broker, 'run_engine', side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')))
        self.f = F.WorkerTests(); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.base = self.f.config
        self.selected = {**copy.deepcopy(self.base), 'browserJobPolicy': str(self.f.root/'host-only-policy.json')}

    def test_actual_create_args_and_both_label_producers_are_exactly_legacy(self):
        home = self.f.root/'home'
        self.assertEqual(create_args(self.base, F.SID, home), create_args(self.selected, F.SID, home))
        self.assertEqual(resource_config(self.base, F.SID), resource_config(self.selected, F.SID))
        self.assertEqual(effective_config(self.base, F.SID), effective_config(self.selected, F.SID))
        self.assertEqual(policy_digest(self.base, F.SID), policy_digest(self.selected, F.SID))
        expected = peer_port.expected_labels(self.base, F.SID)
        self.assertEqual(expected, peer_port.expected_labels(self.selected, F.SID))
        spec = importlib.util.spec_from_file_location('_flat_peer_host_policy', peer_port.__file__)
        flat = importlib.util.module_from_spec(spec); spec.loader.exec_module(flat)
        self.assertEqual(expected, flat.expected_labels(self.selected, F.SID))
        self.assertIn('browserJobPolicy', self.selected)
        self.assertFalse((self.f.root/'host-only-policy.json').exists())

    def test_reload_cannot_add_remove_or_rebind_the_host_control_option(self):
        changed = {**self.selected, 'browserJobPolicy': str(self.f.root/'different-policy.json')}
        for before, after in [(self.base, self.selected), (self.selected, self.base), (self.selected, changed)]:
            with self.subTest(before=before.get('browserJobPolicy'), after=after.get('browserJobPolicy')):
                with self.assertRaisesRegex(ValueError, 'control paths'):
                    validate_resource_reload(before, after)
