"""Current metadata after real canonical source fixtures, never native effects."""
import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from reverie import laptop_resource_operations as J
from reverie import worker_resource_native as N
from tests import test_worker_resource_canonical_launch as C
from tests import test_worker_resource_reservations as F


class NativeThreadMetadata(unittest.TestCase):
    def setUp(self):
        original=F.Reservations.company
        recipe={'mode':'codex','workingDir':'/workspace','configs':{'codexConfig':{
            'model':'fixture-model','reasoningEffort':'high'}},'runtimeThreads':{}}
        def company(selected):
            selected.employee['runtimeRecipe']=copy.deepcopy(recipe);original(selected)
        self.enterContext(patch.object(F.Reservations,'company',company))
        self.case=C.CanonicalResourceLaunch();self.case.setUp();self.addCleanup(self.case.doCleanups)
        self.path=Path(self.case.f.config['companyFile'])
    def change(self,mutation):
        company=json.loads(self.path.read_text());mutation(company['employees'][0]);self.path.write_text(json.dumps(company))
    def started(self):
        self.case.run_request();N.acknowledge_started(self.case.owner,self.case.native.key)
    def test_normal_thread_bookkeeping_after_canonical_cli_start_does_not_change_selected_recipe(self):
        self.started()
        self.change(lambda employee:employee['runtimeRecipe'].update(runtimeThreads={'subscription:same':'new-thread'}))
        self.assertEqual(N.begin_verification(self.case.owner,self.case.native.key)['state'],'VERIFYING')
        operation=self.case.native.case.raw()['operations'][self.case.permit.operation_id]
        self.assertEqual(operation['delta_bytes'],str(2048*J.MIB))
    def test_the_same_change_before_real_cli_start_does_not_become_publication_authority(self):
        self.change(lambda employee:employee['runtimeRecipe'].update(runtimeThreads={'subscription:same':'unproved-thread'}))
        kind,body=self.case.run_request()
        self.assertEqual(kind,b'E');self.assertIn(b'TARGET_BINDING_CHANGED',body)
        self.assertEqual(self.case.events,[])
    def test_model_or_owner_intent_change_after_cli_start_still_refuses_and_retains_hold(self):
        self.started()
        self.change(lambda employee:employee['runtimeRecipe']['configs']['codexConfig'].update(model='another-model'))
        with self.assertRaises(J.OperationCommitUncertain):N.begin_verification(self.case.owner,self.case.native.key)
        operation=self.case.native.case.raw()['operations'][self.case.permit.operation_id]
        self.assertEqual(operation['state'],'STARTED');self.assertEqual(operation['delta_bytes'],str(2048*J.MIB))
    def test_malformed_thread_metadata_is_not_silently_ignored(self):
        self.started();self.change(lambda employee:employee['runtimeRecipe'].update(runtimeThreads={'same':False}))
        with self.assertRaises(J.OperationCommitUncertain):N.begin_verification(self.case.owner,self.case.native.key)
