import hashlib
import hmac
from pathlib import Path
import tempfile
import unittest
import uuid
from reverie.host_actions import ActionQueue,Principal,canonical
from reverie.host_action_rpc import OfficeEnvelope

class OfficeEnvelopeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.now=1000
        self.queue=ActionQueue(str(Path(self.temp.name)/'actions.db'),lambda _: {'managed':True},lambda *_:None,lambda:self.now)
        self.keys={'request':b'a'*32,'owner':b'b'*32}
        self.rpc=OfficeEnvelope(self.queue,self.keys['request'],self.keys['owner'],lambda:self.now)

    def sign(self,method,params,key='request',subject='session-a',issued=None,nonce=None):
        body=canonical(dict(version=1,issuedAt=self.now if issued is None else issued,nonce=nonce or str(uuid.uuid4()),method=method,subject=subject,params=params)).encode()
        return body,key,hmac.new(self.keys[key],body,hashlib.sha256).hexdigest()

    def pending(self):
        return self.rpc.dispatch(*self.sign('request',{'operation':{'action':'verify-runtime-pool'}}))

    def test_request_key_cannot_approve_even_with_owner_subject(self):
        row=self.pending()
        with self.assertRaises(PermissionError):self.rpc.dispatch(*self.sign('decide',{'id':row['id'],'digest':row['digest'],'approve':True},subject='owner'))
        self.assertEqual(self.queue.get(Principal('session-a'),row['id'])['state'],'pending')

    def test_verified_owner_key_can_approve_exact_request(self):
        row=self.pending()
        result=self.rpc.dispatch(*self.sign('decide',{'id':row['id'],'digest':row['digest'],'approve':True},key='owner',subject='owner'))
        self.assertEqual(result['state'],'approved')
        self.assertEqual(self.queue.run(row['id']),'succeeded')

    def test_tampering_replay_and_expired_envelopes_refused(self):
        args=self.sign('request',{'operation':{'action':'verify-runtime-pool'}})
        self.rpc.dispatch(*args)
        with self.assertRaises(PermissionError):self.rpc.dispatch(*args)
        with self.assertRaises(PermissionError):self.rpc.dispatch(args[0]+b' ',*args[1:])
        with self.assertRaises(PermissionError):self.rpc.dispatch(*self.sign('request',{'operation':{'action':'verify-runtime-pool'}},issued=900))

    def test_replay_is_still_refused_after_service_reconstruction(self):
        args=self.sign('request',{'operation':{'action':'verify-runtime-pool'}})
        self.rpc.dispatch(*args)
        rpc=OfficeEnvelope(self.queue,self.keys['request'],self.keys['owner'],lambda:self.now)
        with self.assertRaises(PermissionError):rpc.dispatch(*args)

    def test_no_execute_or_arbitrary_method(self):
        for method in ('run','shell','stop-all'):
            with self.subTest(method=method),self.assertRaises(PermissionError):self.rpc.dispatch(*self.sign(method,{},key='owner'))

    def test_requester_cannot_read_colleague_receipt(self):
        row=self.pending()
        with self.assertRaises(PermissionError):self.rpc.dispatch(*self.sign('get',{'id':row['id']},subject='session-b'))

    def test_malformed_header_and_oversized_body_refused(self):
        for body,key,signature in [(b'{}',[], '0'*64),(b'x'*16385,'request','0'*64),(b'{}','request','bad')]:
            with self.assertRaises(PermissionError):self.rpc.dispatch(body,key,signature)
