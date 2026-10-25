"""Synthetic private stores and sockets; no host operation or real credential."""
import tests  # noqa: F401
import http.client
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

from reverie.worker import OfficeAPI, office_plan_approval

SID = '11111111-2222-3333-4444-555555555555'
OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
PATH = '/api/plans/requests/request/approve'


class PlanApprovalOfficeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.company = self.root/'company'
        self.console = self.company/'console'
        self.directory = self.console/'plan-request-capabilities'/SID
        self.directory.mkdir(parents=True, mode=0o700)
        for directory in [self.console, self.directory.parent, self.directory]:
            directory.chmod(0o700)
        self.file = self.directory/'request.json'
        self.value = dict(requestId='request', sessionId=SID, nonce='a'*64)
        self.file.write_text(json.dumps(self.value)); self.file.chmod(0o600)
        (self.console/'.env').write_text('REVERIE_USERNAME=fixture\nREVERIE_PASSWORD=synthetic\n')

    def approve(self, **kwargs):
        args = dict(company_root=self.company, session_id=SID, path=PATH, method='POST', query='', body=b'{"handoff":"Safe handoff"}')
        args.update(kwargs)
        return office_plan_approval(**args)

    def test_attaches_only_exact_private_credential_and_keeps_handoff(self):
        self.assertEqual(json.loads(self.approve()), dict(handoff='Safe handoff', nonce=self.value['nonce']))
        self.assertEqual(json.loads(self.approve(path=PATH.replace('approve','reject'), body=b'{}')), dict(nonce=self.value['nonce']))
        self.assertEqual(json.loads(self.file.read_text()), self.value)

    def test_other_routes_do_not_touch_private_store(self):
        self.file.unlink()
        for path in ['/api/company', '/api/plans/requests/request/status', '/api/plans/requests/request/approve/extra']:
            self.assertIsNone(self.approve(path=path))

    def test_refuses_nonpost_query_invalid_or_overridden_identity_and_nonce(self):
        changes = [dict(method='GET'), dict(query='other=1'), dict(session_id=OTHER), dict(session_id='../escape'),
                   dict(body=b'{"nonce":"forged","handoff":"Safe"}'), dict(body=b'{"sessionId":"forged","handoff":"Safe"}'),
                   dict(body=b'{"handoff":"one","handoff":"two"}'), dict(body=b'[]'), dict(body=b'\xff'),
                   dict(body=b'{"handoff":""}'), dict(body=b'{"handoff":"bad\\u0000"}'),
                   dict(body=json.dumps({'handoff':'x'*12001}).encode()), dict(body=b'x'*65537)]
        for change in changes:
            with self.subTest(change=list(change)), self.assertRaises((OSError, ValueError, UnicodeError)):
                self.approve(**change)

    def test_refuses_missing_other_request_and_stale_capability_binding(self):
        with self.assertRaises(FileNotFoundError): self.approve(path=PATH.replace('/request/', '/absent/'))
        for changed in [dict(self.value, sessionId=OTHER), dict(self.value, requestId='other'), dict(self.value, nonce='invalid'), dict(self.value, extra=True)]:
            self.file.write_text(json.dumps(changed))
            with self.assertRaises(ValueError): self.approve()
        self.file.unlink()
        with self.assertRaises(FileNotFoundError): self.approve()

    def test_refuses_public_file_and_directories(self):
        for path, mode in [(self.file,0o644), (self.directory,0o755), (self.directory.parent,0o755), (self.console,0o755)]:
            old = path.stat().st_mode & 0o777; path.chmod(mode)
            with self.subTest(path=path.name), self.assertRaises(ValueError): self.approve()
            path.chmod(old)

    def test_refuses_symlink_hardlink_fifo_and_oversized_file(self):
        self.file.unlink(); target=self.root/'target'; target.write_text(json.dumps(self.value));target.chmod(0o600)
        self.file.symlink_to(target)
        with self.assertRaises(OSError): self.approve()
        self.file.unlink();os.link(target,self.file)
        with self.assertRaises(ValueError): self.approve()
        self.file.unlink();os.mkfifo(self.file,0o600)
        with self.assertRaises(ValueError): self.approve()
        self.file.unlink();self.file.write_bytes(b'x'*4097);self.file.chmod(0o600)
        with self.assertRaises(ValueError): self.approve()

    def test_refuses_symlinked_session_and_ancestor(self):
        moved=self.directory.with_name('held');self.directory.rename(moved);self.directory.symlink_to(moved,target_is_directory=True)
        with self.assertRaises(OSError): self.approve()
        self.directory.unlink();moved.rename(self.directory)
        alias=self.root/'alias';alias.symlink_to(self.company,target_is_directory=True)
        with self.assertRaises(OSError): self.approve(company_root=alias)

    def socket_request(self, payload, *, query='', expected_status=200):
        calls=[]
        class Response:
            status=200
            def getheaders(self):return [('Content-Length','34')]
            def read1(self, _):
                if getattr(self,'done',False):return b''
                self.done=True;return b'{"success":true,"phase":"executing"}'
        class Upstream:
            sock = None  # Match HTTPConnection during concurrent OfficeAPI teardown.
            def __init__(self,*args,**kwargs):pass
            def request(self,method,path,body,headers):calls.append((method,path,body,headers))
            def getresponse(self):return Response()
            def close(self):pass
        connection=http.client.HTTPConnection('localhost')
        office=OfficeAPI(self.root/'office',SID,'synthetic-upstream',self.company)
        try:
            with patch('reverie.worker.http.client.HTTPConnection',Upstream):
                connection.sock=socket.socket(socket.AF_UNIX)
                connection.sock.connect(str(self.root/'office/office.sock'))
                connection.request('POST',PATH+query,body=payload,headers={'Content-Type':'application/json','X-Reverie-Parent-Session':OTHER,'X-Reverie-Service-Token':'forged','Cookie':'forged'})
                response=connection.getresponse();raw=response.read()
                self.assertEqual(response.status,expected_status)
                self.assertNotIn(self.value['nonce'].encode(),raw)
        finally:
            connection.close();office.close()
        return calls

    def test_real_office_socket_fixes_session_and_never_returns_nonce(self):
        calls=self.socket_request(b'{"handoff":"Safe handoff"}')
        self.assertEqual(len(calls),1)
        self.assertEqual(json.loads(calls[0][2]),dict(handoff='Safe handoff',nonce=self.value['nonce']))
        headers=calls[0][3]
        self.assertEqual(headers['X-Reverie-Parent-Session'],SID)
        self.assertNotIn('Cookie',headers);self.assertNotIn('X-Reverie-Service-Token',headers)
        self.assertEqual(headers['Content-Length'],str(len(calls[0][2])))

    def test_real_office_socket_refusal_sends_nothing_upstream(self):
        self.file.unlink()
        self.assertEqual(self.socket_request(b'{"handoff":"Safe handoff"}',expected_status=403),[])
        self.assertEqual(self.socket_request(b'{"nonce":"forged","handoff":"Safe"}',expected_status=403),[])


if __name__ == '__main__':
    unittest.main()
