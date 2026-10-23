import http.client
from pathlib import Path
import socket
import tempfile
import unittest
from reverie.worker import OfficeAPI
from reverie.host_action_http import HostActionRefused, HostActionUnconfirmed

SID='11111111-1111-4111-8111-111111111111'

class HostActionOfficeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.calls=[]
        def actions(session,method,params):
            self.calls.append((session,method,params));return {'state':'pending'}
        # No website/company credential files exist. Host-action routing must not
        # read them or proxy to the website's owner route.
        self.office=OfficeAPI(self.root/'office',SID,'unreachable',self.root/'missing',actions)
        self.addCleanup(self.office.close)

    def call(self,method,path,body=None,headers=None):
        conn=http.client.HTTPConnection('localhost');transport=socket.socket(socket.AF_UNIX)
        transport.connect(str(self.root/'office/office.sock'));conn.sock=transport
        conn.request(method,path,body,headers or {})
        result=conn.getresponse();data=result.read();status=result.status;conn.close()
        return status,data

    def test_session_identity_is_fixed_by_private_office_socket(self):
        status,_=self.call('POST','/api/host-actions','{"operation":{"action":"verify-runtime-pool"}}',{'X-Reverie-Parent-Session':'forged','Cookie':'reverie_owner=forged'})
        self.assertEqual(status,200)
        self.assertEqual(self.calls,[(SID,'request',{'operation':{'action':'verify-runtime-pool'}})])

    def test_approval_and_identity_injection_never_reach_host_queue(self):
        for method,path,body in [('POST','/api/host-actions/'+SID+'/decide','{}'),('POST','/api/host-actions','{"operation":{},"subject":"owner"}'),('GET','/api/host-actions?subject=owner',None)]:
            with self.subTest(path=path):self.assertIn(self.call(method,path,body)[0],(400,403))
        self.assertEqual(self.calls,[])

    def test_receipt_list_and_get_are_scoped_to_same_session(self):
        self.assertEqual(self.call('GET','/api/host-actions')[0],200)
        self.assertEqual(self.call('GET','/api/host-actions/'+SID)[0],200)
        self.assertEqual(self.calls,[(SID,'list',{}),(SID,'get',{'id':SID})])

    def test_disabled_host_actions_fail_closed_instead_of_website_proxy(self):
        self.office.close()
        self.office=OfficeAPI(self.root/'office',SID,'unreachable',self.root/'missing')
        self.addCleanup(self.office.close)
        self.assertEqual(self.call('POST','/api/host-actions','{}')[0],503)

    def test_refusal_and_uncertain_result_are_distinct_and_sanitized(self):
        for error,status in [(HostActionRefused(403),403),
                (HostActionUnconfirmed('private host path'),502)]:
            self.office.close()
            def actions(*_):raise error
            self.office=OfficeAPI(self.root/'office',SID,'unreachable',self.root/'missing',actions)
            self.addCleanup(self.office.close)
            actual,body=self.call('POST','/api/host-actions','{"operation":{"action":"verify-runtime-pool"}}')
            self.assertEqual(actual,status)
            self.assertNotIn(b'private host path',body)
            self.assertIn(b'refused' if status==403 else b'unconfirmed',body)
