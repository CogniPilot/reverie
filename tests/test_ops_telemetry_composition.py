"""The optional OPS and telemetry phone routes coexist across broker recovery."""
import json
import tempfile
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock
from reverie.worker import Broker, OfficeAPI
from tests.test_ops_office import UnixHTTP
from tests import test_owner_goal_broker as goal_fixture
SID = goal_fixture.SID

COMMAND = dict(kind='reverie.ops.command', version=1, requestId='composition-status',
               action='reverie.ops.status', resourceId='website')

class PhoneComposition(unittest.TestCase):
    def request(self, socket, path, value):
        client = UnixHTTP(socket)
        try:
            client.request('POST', path, json.dumps(value))
            response = client.getresponse()
            return response.status, response.read()
        finally:
            client.close()

    def test_both_routes_keep_fixed_phone_identity_without_website(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); calls = []
            telemetry = SimpleNamespace(observe=lambda sid, raw: calls.append(('telemetry', sid, json.loads(raw))) or True)
            def ops(sid, command):
                calls.append(('ops', sid, command)); return {'success': True}
            def upstream():
                raise AssertionError('website must not receive either private route')
            office = OfficeAPI(root/'phone', SID, upstream, root, ops=ops, command_telemetry=telemetry)
            try:
                self.assertEqual(self.request(root/'phone/office.sock', '/api/ops', COMMAND)[0], 200)
                self.assertEqual(self.request(root/'phone/office.sock', '/api/command-telemetry/hands', {'event':'fixture'})[0], 204)
                self.assertEqual(calls, [('ops', SID, COMMAND), ('telemetry', SID, {'event':'fixture'})])
            finally:
                office.close()

    def test_recovered_laptop_keeps_both_private_callbacks(self):
        fixture = goal_fixture.OwnerGoalBrokerTests(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        calls = []; recovered_sid = '22222222-2222-3333-4444-555555555555'
        fixture.broker.command_telemetry = SimpleNamespace(enabled=True, observe=lambda sid, raw: calls.append(('telemetry',sid)) or True)
        fixture.broker.ops = lambda sid, command: calls.append(('ops',sid)) or {'success':True}
        fixture.broker.run_engine = Mock(return_value=subprocess.CompletedProcess([],0,'test-agent-'+recovered_sid,''))
        fixture.broker.recover()
        self.assertEqual([call.args[0][0] for call in fixture.broker.run_engine.call_args_list],['ps'])
        office = fixture.broker.offices[recovered_sid]; self.addCleanup(office.close)
        socket = Path(fixture.config['apiSocketRoot'])/recovered_sid/'office.sock'
        self.assertEqual(self.request(socket,'/api/ops',COMMAND)[0],200)
        self.assertEqual(self.request(socket,'/api/command-telemetry/hands',{})[0],204)
        self.assertEqual(calls,[('ops',recovered_sid),('telemetry',recovered_sid)])

    def test_disabled_options_keep_legacy_office_constructor_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            broker=Broker({'maxWorkers':1,'apiSocketRoot':directory,'companyRoot':directory})
            sentinel=object()
            def old_constructor(directory,sid,address,company_root,host_actions=None):
                return sentinel
            with patch('reverie.worker.OfficeAPI',side_effect=old_constructor):
                self.assertIs(broker.office(SID),sentinel)


class DirectFileOps(unittest.TestCase):
    """The packaged broker executes worker.py directly, with no package context."""
    def script_module(self):
        import importlib.util
        import sys
        import reverie.worker
        name = '_reverie_direct_ops_' + str(id(self))
        spec = importlib.util.spec_from_file_location(name, reverie.worker.__file__)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        self.addCleanup(sys.modules.pop, name, None)
        spec.loader.exec_module(module)
        self.assertFalse(module.__package__)
        return module

    def test_direct_file_ops_phone_reaches_fixed_callback(self):
        module = self.script_module(); calls = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            def ops(sid, command):
                calls.append((sid, command)); return {'success':True}
            office = module.OfficeAPI(root/'phone', SID, 'unavailable', root, ops=ops)
            try:
                status, raw = PhoneComposition.request(self,root/'phone/office.sock','/api/ops',COMMAND)
                self.assertEqual(status,200)
                self.assertTrue(json.loads(raw)['success'])
                self.assertEqual(calls,[(SID,COMMAND)])
            finally:
                office.close()

    def test_direct_file_load_config_keeps_private_binding_validation(self):
        module = self.script_module()
        from tests.test_ops_office import BrokerConfiguration
        fixture = BrokerConfiguration()
        with patch('reverie.worker.load_config', module.load_config):
            fixture.test_real_load_config_accepts_only_typed_private_ops_binding()

    def test_direct_file_callback_uses_selected_host_transport(self):
        module = self.script_module(); client = Mock()
        client.call.return_value = {'success':True}
        with patch('reverie.ops_service.phone_client',return_value=client) as phone:
            broker = module.Broker({'maxWorkers':1,'opsConfig':'/owned-fixture/ops.json'})
            self.assertEqual(broker.ops(SID,COMMAND),{'success':True})
        phone.assert_called_once_with('/owned-fixture/ops.json')
        client.call.assert_called_once_with(SID,COMMAND)
