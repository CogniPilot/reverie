import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from reverie.host_actions import ActionQueue
from reverie.host_action_rpc import OfficeEnvelope
from reverie.host_action_http import ActionHTTPServer,OfficeActionClient,HostActionRefused,HostActionUnconfirmed

class HostActionHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name)
        queue=ActionQueue(str(root/'queue.db'),lambda _:{'target':'fixture'},lambda *_:None)
        self.queue=queue
        self.envelope=OfficeEnvelope(queue,b'a'*32,b'b'*32)
        self.path=root/'office.sock'
        self.server=ActionHTTPServer(self.path,self.envelope,{os.getuid()});self.addCleanup(self.server.close)
        self.agent=OfficeActionClient(self.path,b'a'*32,'session-a')
        self.owner=OfficeActionClient(self.path,b'b'*32,'owner','owner')

    def test_real_private_http_queue_and_owner_decision(self):
        request=self.agent.call('request',{'operation':{'action':'verify-runtime-pool'}})
        self.assertEqual(self.agent.call('list',{})[0]['id'],request['id'])
        self.owner.call('decide',{'id':request['id'],'digest':request['digest'],'approve':True})
        self.assertEqual(self.agent.call('get',{'id':request['id']})['state'],'approved')
        self.assertEqual(self.path.stat().st_mode&0o777,0o600)

    def test_agent_cannot_approve_or_list_colleague_requests(self):
        request=self.agent.call('request',{'operation':{'action':'verify-runtime-pool'}})
        with self.assertRaises(ValueError):self.agent.call('decide',{'id':request['id'],'digest':request['digest'],'approve':True})
        other=OfficeActionClient(self.path,b'a'*32,'session-b')
        self.assertEqual(other.call('list',{}),[])
        self.assertEqual(len(self.owner.call('list',{})),1)

    def test_wrong_key_is_refused(self):
        wrong=OfficeActionClient(self.path,b'c'*32,'session-a')
        with self.assertRaises(ValueError):wrong.call('list',{})

    def test_existing_socket_is_not_stolen(self):
        with self.assertRaises(ValueError):ActionHTTPServer(self.path,self.envelope,{os.getuid()})

    def test_shared_or_symlinked_socket_parent_is_refused(self):
        shared=Path(self.temp.name)/'shared';shared.mkdir();shared.chmod(0o755)
        with self.assertRaises(ValueError):ActionHTTPServer(shared/'office.sock',self.envelope,{os.getuid()})
        link=Path(self.temp.name)/'link';link.symlink_to(Path(self.temp.name),target_is_directory=True)
        with self.assertRaises(ValueError):ActionHTTPServer(link/'other.sock',self.envelope,{os.getuid()})

    def test_owner_list_remains_bounded_for_large_previews(self):
        self.queue.resolve=lambda _:{'target':'x'*3000}
        for n in range(30):
            OfficeActionClient(self.path,b'a'*32,'session-'+str(n)).call('request',{'operation':{'action':'verify-runtime-pool'}})
        rows=self.owner.call('list',{})
        self.assertGreater(len(rows),0)
        self.assertLess(len(rows),30)
        from reverie.host_actions import canonical
        self.assertLessEqual(len(canonical(rows).encode()),48*1024)

    def test_definite_refusal_is_not_a_missing_response(self):
        with self.assertRaises(HostActionRefused) as result:
            OfficeActionClient(self.path,b'c'*32,'session-a').call('list',{})
        self.assertEqual(result.exception.status,403)

    def test_bad_or_lost_response_stays_uncertain_without_retry(self):
        for status,body in [(500,b'private server diagnostics'),(200,b'invalid json'),
                (200,b'{"success":false,"data":null}'),(200,b'x'*65537)]:
            with self.subTest(status=status,body_length=len(body)):
                response=Mock(status=status);response.read.return_value=body
                connection=Mock();connection.getresponse.return_value=response
                with patch('reverie.host_action_http.http.client.HTTPConnection',return_value=connection) as connect:
                    with self.assertRaises(HostActionUnconfirmed) as result:self.agent.call('list',{})
                    self.assertEqual(str(result.exception),'Host response unconfirmed')
                    self.assertEqual(connect.call_count,1)
                    self.assertEqual(connection.request.call_count,1)
        connection=Mock();connection.getresponse.side_effect=ConnectionResetError('private path')
        with patch('reverie.host_action_http.http.client.HTTPConnection',return_value=connection):
            with self.assertRaises(HostActionUnconfirmed) as result:self.agent.call('list',{})
            self.assertNotIn('private',str(result.exception))
            self.assertEqual(connection.request.call_count,1)

class AbsoluteDeadlineTests(unittest.TestCase):
    def test_deadline_does_not_cancel_or_retry_dispatched_queue_work(self):
        import threading
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw);entered=threading.Event();release=threading.Event();committed=threading.Event()
            def resolve(_):
                entered.set()
                if not release.wait(3):raise RuntimeError('Fixture release missing')
                return {'target':'fixture'}
            queue=ActionQueue(root/'queue.db',resolve,lambda *_:None)
            real=OfficeEnvelope(queue,b'a'*32,b'b'*32)
            def dispatch(*args):
                result=real.dispatch(*args);committed.set();return result
            envelope=Mock();envelope.dispatch.side_effect=dispatch
            with patch('reverie.host_action_http.IO_DEADLINE_SECONDS',1,create=True):
                server=ActionHTTPServer(root/'host.sock',envelope,{os.getuid()})
                try:
                    with self.assertRaises(HostActionUnconfirmed):
                        OfficeActionClient(root/'host.sock',b'a'*32,'fixture').call('request',{'operation':{'action':'verify-runtime-pool'}})
                    self.assertTrue(entered.is_set())
                    release.set();self.assertTrue(committed.wait(3))
                    from reverie.host_actions import Principal
                    rows=queue.list(Principal('fixture'))
                    self.assertEqual(len(rows),1)
                    self.assertEqual(rows[0]['state'],'pending')
                    self.assertEqual(envelope.dispatch.call_count,1)
                finally:release.set();server.close()

    def test_dripped_headers_and_body_cannot_keep_server_slot(self):
        import socket,threading,time
        for initial in [b'POST /v1/host-actions HTTP/1.0\r\nX-Probe: ',
                b'POST /v1/host-actions HTTP/1.0\r\nContent-Length: 100\r\n\r\n']:
            with self.subTest(initial=initial),tempfile.TemporaryDirectory() as raw:
                envelope=Mock()
                with patch('reverie.host_action_http.IO_DEADLINE_SECONDS',1,create=True):
                    server=ActionHTTPServer(Path(raw)/'host.sock',envelope,{os.getuid()})
                    client=socket.socket(socket.AF_UNIX);client.settimeout(3)
                    try:
                        client.connect(str(Path(raw)/'host.sock'));client.sendall(initial)
                        stop=threading.Event()
                        def drip():
                            try:
                                while not stop.wait(.1):client.sendall(b'x')
                            except OSError:pass
                        thread=threading.Thread(target=drip);thread.start()
                        try:
                            try:
                                closed = client.recv(1)
                            except ConnectionResetError:
                                # Closing an overdue request with unread bytes may reset an AF_UNIX socket.
                                closed = b''
                            self.assertEqual(closed,b'')
                        finally:
                            stop.set();thread.join(3)
                        self.assertFalse(thread.is_alive())
                        self.assertEqual(envelope.dispatch.call_count,0)
                    finally:client.close();server.close()

    def test_dripped_valid_response_is_unconfirmed_once(self):
        import socket,threading
        with tempfile.TemporaryDirectory() as raw:
            path=Path(raw)/'slow.sock';listener=socket.socket(socket.AF_UNIX)
            listener.bind(str(path));listener.listen(1);listener.settimeout(3)
            requests=[];stop=threading.Event()
            def serve():
                conn,_=listener.accept()
                try:
                    requests.append(conn.recv(65536))
                    body=b'{"success":true,"data":{"ok":true}}'
                    conn.sendall(b'HTTP/1.0 200 OK\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n')
                    for index in range(0,len(body),8):
                        if index and stop.wait(.6):break
                        conn.sendall(body[index:index+8])
                except OSError:pass
                finally:conn.close()
            thread=threading.Thread(target=serve);thread.start()
            try:
                with patch('reverie.host_action_http.IO_DEADLINE_SECONDS',1,create=True):
                    with self.assertRaises(HostActionUnconfirmed):
                        OfficeActionClient(path,b'a'*32,'fixture').call('list',{})
                self.assertEqual(len(requests),1)
            finally:stop.set();thread.join(3);listener.close()
            self.assertFalse(thread.is_alive())

    def test_invalid_utf8_response_is_sanitized_once(self):
        import socket,threading
        with tempfile.TemporaryDirectory() as raw:
            path=Path(raw)/'bad.sock';listener=socket.socket(socket.AF_UNIX)
            listener.bind(str(path));listener.listen(1);listener.settimeout(3)
            requests=[]
            def serve():
                conn,_=listener.accept()
                try:
                    # Consume the request so closure cannot masquerade as a
                    # decoding failure through an unread-request reset.
                    with conn.makefile('rb') as stream:
                        request=stream.readline();length=0
                        while True:
                            line=stream.readline();request+=line
                            if line==b'\r\n':break
                            if line.lower().startswith(b'content-length:'):
                                length=int(line.split(b':',1)[1])
                        request+=stream.read(length)
                    requests.append(request)
                    conn.sendall(b'HTTP/1.0 200 OK\r\nContent-Length: 1\r\n\r\n\xff')
                finally:conn.close()
            thread=threading.Thread(target=serve);thread.start()
            try:
                with self.assertRaises(HostActionUnconfirmed) as caught:
                    OfficeActionClient(path,b'a'*32,'fixture').call('list',{})
                self.assertEqual(str(caught.exception),'Host response unconfirmed')
                self.assertIsInstance(caught.exception.__cause__,UnicodeDecodeError)
                self.assertEqual(len(requests),1)
            finally:thread.join(3);listener.close()
            self.assertFalse(thread.is_alive())
