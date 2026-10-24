"""Actual owned Office socket refusals; no host socket, engine or real credential."""
import tests  # noqa: F401
import http.client
import json
from pathlib import Path
import socket
import unittest
from unittest.mock import patch
from tests import test_plan_approval_office as base
from reverie.worker import OfficeAPI, office_plan_approval


class PlanCredentialBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = base.PlanApprovalOfficeTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_retired_export_refuses_before_any_private_lookup(self):
        missing = self.fixture.root/'absent-private-root'
        for method in ('GET', 'POST', 'HEAD'):
            for path in ('/api/plans/requests/request/credential', '/api/plans/requests/request/%63redential'):
                with self.subTest(method=method, path=path), self.assertRaises(ValueError):
                    office_plan_approval(missing, base.SID, path, method, 'ignored=1', b'{}')

    def test_actual_office_never_forwards_or_returns_legacy_capability(self):
        f = self.fixture
        calls = []
        body = json.dumps({'success': True, 'data': f.value}).encode()
        class Response:
            status = 200
            def getheaders(self): return [('Content-Length', str(len(body)))]
            def read1(self, _):
                if getattr(self, 'done', False): return b''
                self.done = True
                return body
        class Upstream:
            def __init__(self, *args, **kwargs): pass
            def request(self, *args, **kwargs): calls.append((args, kwargs))
            def getresponse(self): return Response()
            def close(self): pass
        office = OfficeAPI(f.root/'office-deny', base.SID, 'synthetic-upstream', f.company)
        try:
            with patch('reverie.worker.http.client.HTTPConnection', Upstream):
                for method, suffix in [('POST','request/credential'),('GET','request/credential'),
                        ('HEAD','request/credential'),('POST','request/credential?query=1'),
                        ('POST','request/%63redential'),('POST','%72equest/credential')]:
                    # The test's client must remain the original HTTPConnection class.
                    connection = CLIENT('localhost')
                    try:
                        connection.sock = socket.socket(socket.AF_UNIX)
                        connection.sock.connect(str(f.root/'office-deny/office.sock'))
                        connection.request(method, '/api/plans/requests/'+suffix, body=b'{}',
                            headers={'X-Reverie-Parent-Session': base.OTHER, 'X-Reverie-Service-Token': 'forged', 'Cookie':'forged'})
                        response = connection.getresponse(); raw = response.read()
                        self.assertEqual(response.status, 403)
                        self.assertNotIn(f.value['nonce'].encode(), raw)
                        self.assertEqual(calls, [])
                    finally:
                        connection.close()
        finally:
            office.close()


CLIENT = http.client.HTTPConnection
if __name__ == '__main__':
    unittest.main()
