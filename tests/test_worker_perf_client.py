"""Fixed client schema and exact post-config proof; no manager/native calls."""
import copy
import io
from pathlib import Path
import unittest
from unittest.mock import patch
from reverie import worker_perf_client as C

class PerfClient(unittest.TestCase):
    def test_only_exact_expected_config_and_same_registered_program_peer_can_finalize(self):
        for changed in (None,'configuration','unit','process','environment','socket','generationRoot'):
            with self.subTest(changed=changed):
                proof=object.__new__(C.PerfTransport);proof.service=type('S',(),{'config_path':Path('/owned/broker.json')})()
                expected={'employeePerfPolicies':{'employee':'task-v1'}}
                before={'config':'old-private-bytes','unit':'oldunit','process':'oldbirth','environment':'oldenv','socket':'oldsocket','generationRoot':'oldroot'}
                proof.selection=before;proof.config={}
                after={**before,'config':'new-private-bytes'}
                if changed and changed!='configuration':after[changed]='foreign'
                config=dict(expected,memoryMiB=9) if changed=='configuration' else expected
                with patch.object(C,'load_config',return_value=config),patch.object(proof,'observe',return_value=after),patch.object(proof,'finalize') as finalized:
                    if changed is None:
                        proof.finalize_apply(expected);finalized.assert_called_once();self.assertEqual(proof.selection,after)
                    else:
                        with self.assertRaises(ValueError):proof.finalize_apply(expected)
                        finalized.assert_not_called()

    def test_cli_queues_only_closed_current_binding_and_never_invents_owner(self):
        current={'id':'employee','owner':'instance-owner','sessionId':'sid','sessionGeneration':2,'bindingDigest':'digest'}
        calls=[]
        def call(path,command,plan=None):
            calls.append(command)
            if command['action']=='perf-policy-status':return {'current':current,'revision':3}
            return {'version':1,'purpose':'owner-task-perf-v1','state':'pending'}
        with patch.object(C,'_call',side_effect=call),patch('sys.stdout',new_callable=io.StringIO):
            self.assertEqual(C.main(['--config','/owned/config','--employee','employee','request','--enable']),0)
        self.assertEqual(calls,[{'action':'perf-policy-status','employeeId':'employee'},
            {'action':'perf-policy-request','employeeId':'employee','enabled':True,
             'expected':{'sessionId':'sid','sessionGeneration':2,'bindingDigest':'digest','revision':3}}])

    def test_apply_requires_exact_fresh_preview_and_unknown_response_never_retries(self):
        calls=[]
        def call(path,command,plan=None):
            calls.append(command)
            return {'version':1,'purpose':'owner-task-perf-v1','state':'READY_COLD','planDigest':'other','plan':{}}
        with patch.object(C,'_call',side_effect=call),patch('sys.stderr',new_callable=io.StringIO):
            self.assertEqual(C.main(['--config','/owned/config','--employee','employee','apply','--plan-digest','approved']),1)
        self.assertEqual(len(calls),1);self.assertEqual(calls[0]['action'],'perf-policy-preview')
        calls.clear()
        def fail(path,command,plan=None):calls.append(command);raise EOFError('owned lost ACK')
        with patch.object(C,'_call',side_effect=fail),patch('sys.stderr',new_callable=io.StringIO):
            self.assertEqual(C.main(['--config','/owned/config','--employee','employee','status']),1)
        self.assertEqual(len(calls),1)

    def test_action_flag_combinations_are_closed_before_any_native_call(self):
        for flags in (['request'],['apply'],['status','--enable'],['request','--enable','--plan-digest','x'],
                      ['preview','--plan-digest','x'],['apply','--plan-digest','x','--disable']):
            with self.subTest(flags=flags),patch.object(C,'_call',side_effect=AssertionError('NO_NATIVE')),patch('sys.stderr',new_callable=io.StringIO):
                with self.assertRaises(SystemExit):C.main(['--config','/owned/config','--employee','employee',*flags])
