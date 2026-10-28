"""Pre-approval canonical RAM choice; real stores, fixed native metadata only."""
import copy
import json
from pathlib import Path
import unittest

from reverie import laptop_resource_operations as J
from reverie.worker_resource_preparation import ResourcePreparationOwner
from reverie.worker_resources import effective_config
from tests import test_worker_resource_reservations as F


class ResourcePreviewProfile(unittest.TestCase):
    def setUp(self):
        self.f=F.Reservations();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.f.native.resource_reservations=self.f.gate
        self.owner=ResourcePreparationOwner(self.f.native);self.addCleanup(self.owner.close)

    def operations(self):
        with self.f.gate.admission():return self.f.gate._document()['operations']

    def test_ram_selection_is_canonical_before_approval_without_claim_or_policy_effect(self):
        config=copy.deepcopy(self.f.config);company=Path(config['companyFile']).read_bytes()
        draft=self.owner.draft(F.EID,F.KEY,memory_mib=3072)
        selected=self.f.profiles.snapshot()['profiles'][F.EID]
        self.assertEqual(selected['version'],2);self.assertEqual(draft['profileVersion'],'2')
        self.assertEqual(draft['resources'],dict(self.f.resources,memoryMiB=3072))
        self.assertEqual(draft['sourceMemoryMiB'],2048)
        self.assertEqual(selected['binding']['current_sid'],F.SID)
        self.assertNotEqual(selected['binding']['target_sid'],F.SID)
        self.assertEqual(selected['binding']['target_generation'],2)
        self.assertEqual(draft['profileDigest'],J.fingerprint(selected))
        self.assertFalse(draft['capacityHeld']);self.assertFalse(draft['nativeEffects'])
        self.assertEqual(self.operations(),{})
        self.assertEqual(self.f.config,config);self.assertEqual(Path(config['companyFile']).read_bytes(),company)
        self.assertEqual(effective_config(config,F.SID)['memoryMiB'],2048)
        self.assertTrue(all(args[0] in ('ps','inspect') for args in self.f.native.calls))

    def test_new_preview_invalidates_previous_profile_but_never_rewrites_an_executing_claim(self):
        old=self.owner.draft(F.EID,F.KEY,memory_mib=3072)
        new=self.owner.draft(F.EID,F.TARGET,memory_mib=4096)
        self.assertNotEqual(old['targetSid'],new['targetSid'])
        with self.assertRaisesRegex(ValueError,'DRAFT_CHANGED'):
            self.owner.reserve(old['draftId'],old['previewDigest'])
        self.owner.reserve(new['draftId'],new['previewDigest'])
        before=(self.f.control/'profiles/profiles.json').read_bytes()
        with self.assertRaisesRegex(ValueError,'EMPLOYEE_CLAIM_RETAINED'):
            self.owner.draft(F.EID,F.KEY,memory_mib=5120)
        self.assertEqual((self.f.control/'profiles/profiles.json').read_bytes(),before)
        self.assertEqual(len(self.operations()),1)

    def test_bad_ram_and_stopped_owner_intent_refuse_before_profile_write(self):
        before=(self.f.control/'profiles/profiles.json').read_bytes()
        for value in (True,None,0,511,1048577,float('inf'),'4096'):
            if value is None:continue # Omission preserves the accepted internal primitive.
            with self.subTest(value=value),self.assertRaises(ValueError):
                self.owner.draft(F.EID,F.KEY,memory_mib=value)
            self.assertEqual((self.f.control/'profiles/profiles.json').read_bytes(),before)
        self.f.employee['desiredRunning']=False;self.f.company()
        with self.assertRaisesRegex(ValueError,'CURRENT_EMPLOYEE_REQUIRED'):
            self.owner.draft(F.EID,F.KEY,memory_mib=4096)
        self.assertEqual((self.f.control/'profiles/profiles.json').read_bytes(),before)

    def test_initial_profile_can_be_selected_without_installing_or_changing_any_worker_policy(self):
        # This is the supported empty canonical store, not deleting live state.
        snapshot=self.f.profiles.snapshot();snapshot['profiles']={}
        (self.f.control/'profiles/profiles.json').write_bytes(J.encode(snapshot))
        draft=self.owner.draft(F.EID,F.KEY,memory_mib=3072)
        self.assertEqual(draft['profileVersion'],'1')
        self.assertEqual(self.operations(),{})

    def test_publication_intent_uses_normal_fresh_thread_settings_without_claiming_context_transfer(self):
        recipe={'mode':'codex','workingDir':'/workspace','configs':{'codexConfig':{
            'model':'fixture-model','reasoningEffort':'high','resumeSessionId':'old-thread'}},
            'runtimeThreads':{'subscription:same':'old-thread'}}
        self.f.employee['runtimeRecipe']=copy.deepcopy(recipe);self.f.company()
        draft=self.owner.draft(F.EID,F.KEY,memory_mib=3072)
        key=self.owner.reserve(draft['draftId'],draft['previewDigest'])['claimKey']
        self.owner.begin_prepare(key)
        intent=self.owner._current(key)['receipt']
        expected=copy.deepcopy(recipe);expected['runtimeThreads']={}
        expected['configs']['codexConfig'].pop('resumeSessionId')
        self.assertEqual(intent['beforeEmployee']['runtimeRecipe'],recipe)
        self.assertEqual(intent['afterEmployee']['runtimeRecipe'],expected)
        self.assertEqual(json.loads(Path(self.f.config['companyFile']).read_text())['employees'][0]['runtimeRecipe'],recipe)
        self.assertEqual(self.operations()[intent['operationId']]['state'],'PREPARING')
