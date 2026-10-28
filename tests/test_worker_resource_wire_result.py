"""Purpose-local numeric interop/projection, no receipt or native authority."""
import copy
import json
import unittest
from reverie import worker_resource_actor as A
from reverie import laptop_resource_operations as J

class ResourceWireResult(unittest.TestCase):
    def draft(self,cpus):
        return {'draftId':'a','operationId':'b','reservationId':'c','targetSid':'d','profileVersion':'1',
            'profileDigest':'a'*64,'previewDigest':'b'*64,'sourceMemoryMiB':2048,'capacityHeld':False,
            'nativeEffects':False,'resources':{'budgetMode':'admission','memoryMiB':4096,'pidsLimit':128,
                'cpus':cpus,'poolMemoryMiB':8192,'poolTasksMax':512}}
    def test_valid_integral_float_cpu_is_unchanged_numerically_and_canonical_for_javascript(self):
        for value in (0.0,-0.0,1.0,64.0):
            source=self.draft(value);before=J.encode(source)
            result=A._wire_result('draft',source)
            self.assertIs(type(result['resources']['cpus']),int)
            self.assertEqual(result['resources']['cpus'],value)
            self.assertEqual(J.encode(source),before)
            self.assertIs(type(json.loads(A.encoded(result))['resources']['cpus']),int)
    def test_fractional_cpu_remains_exact_and_invalid_policy_is_not_made_valid(self):
        self.assertEqual(A._wire_result('draft',self.draft(.25))['resources']['cpus'],.25)
        for value in (True,float('nan'),float('inf'),.1):
            with self.subTest(value=value),self.assertRaises(ValueError):A._wire_result('draft',self.draft(value))
    def test_native_receipts_remain_private_and_byte_exact_despite_wide_inode_fields(self):
        for verb,state in [('prepare','PREPARED_CONFIG_ONLY_SOURCE_UNCHANGED'),
                           ('start','STARTED_READINESS_NOT_VERIFIED'),('verify','VERIFY_RECORDED_CAPACITY_RETAINED')]:
            value={'state':state,'operationId':'a','reservationId':'b','profileDigest':'c'*64,'capacityRetained':True,
                'nativeFacts':{'inode':2**63+17},'schema':'private-receipt'}
            before=J.encode(value);result=A._wire_result(verb,value)
            self.assertNotIn('nativeFacts',result);self.assertNotIn('schema',result)
            self.assertEqual(J.encode(value),before);self.assertNotIn(str(2**63+17).encode(),A.encoded(result))
    def test_unknown_verb_missing_field_and_nonclosed_draft_refuse(self):
        with self.assertRaises(ValueError):A._wire_result('callback',{})
        with self.assertRaises(KeyError):A._wire_result('finalize',{'state':'x'})
        with self.assertRaises(ValueError):A._wire_result('draft',dict(self.draft(1),owner=True))
