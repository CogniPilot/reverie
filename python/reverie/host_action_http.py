"""Bounded private Unix HTTP transport for office host actions.

Only the owner host mounts this socket and signing keys into the website. Laptop
requests enter through their existing session-scoped office proxy, not this socket.
"""
import hashlib
import hmac
import http.client
import http.server
import json
import os
from pathlib import Path
import socket
import socketserver
import struct
import stat
import threading
import time
import uuid

from .host_actions import canonical
from .host_action_rpc import MAX_BODY

MAX_RESPONSE = 64 * 1024
ENDPOINT = '/v1/host-actions'
IO_DEADLINE_SECONDS = 5


class DeadlineSocket(socket.socket):
    """One monotonic budget shared by connect, buffered reads and writes.

    SocketIO from makefile() calls recv_into on this socket for each fill, so
    a peer dripping headers or a response cannot renew an inactivity timeout.
    A deadline closes transport IO, never cancels or retries a queue operation.
    """
    def __init__(self, *args, clock=time.monotonic, **kwargs):
        super().__init__(*args, **kwargs)
        self.clock=clock
        self.deadline=clock()+IO_DEADLINE_SECONDS

    def remaining(self):
        remaining=self.deadline-self.clock()
        if remaining<=0:
            raise TimeoutError('Host transport deadline exceeded')
        return remaining

    def check_deadline(self):
        self.settimeout(self.remaining())

    def connect(self,address):
        self.check_deadline()
        return super().connect(address)

    def recv(self,size,flags=0):
        self.check_deadline()
        return super().recv(size,flags)

    def recv_into(self,buffer,nbytes=0,flags=0):
        self.check_deadline()
        return super().recv_into(buffer,nbytes,flags)

    def send(self,data,flags=0):
        self.check_deadline()
        return super().send(data,flags)

    def sendall(self,data,flags=0):
        self.check_deadline()
        return super().sendall(data,flags)


class HostActionRefused(ValueError):
    """An explicit HTTP refusal, as distinct from an uncertain response."""
    def __init__(self, status):
        self.status=status
        super().__init__('Host action request refused')


class HostActionUnconfirmed(RuntimeError):
    pass


class OfficeActionClient:
    """Fixed endpoint/signer; credentials are supplied only by host configuration."""
    def __init__(self, socket_path, key, subject, key_id='request', clock=time.time):
        if key_id not in ('request','owner') or not isinstance(key,bytes) or len(key)<32:
            raise ValueError('Invalid private host action signer')
        self.socket_path=str(socket_path)
        self.key,self.subject,self.key_id,self.clock=key,subject,key_id,clock

    def call(self, method, params):
        body=canonical(dict(version=1,issuedAt=int(self.clock()),nonce=str(uuid.uuid4()),
            method=method,subject=self.subject,params=params)).encode()
        if len(body)>MAX_BODY:
            raise ValueError('Host action request exceeds limit')
        signature=hmac.new(self.key,body,hashlib.sha256).hexdigest()
        conn=http.client.HTTPConnection('localhost',timeout=5)
        transport=DeadlineSocket(socket.AF_UNIX)
        try:
            transport.connect(self.socket_path)
            conn.sock=transport
            conn.request('POST',ENDPOINT,body,{'Content-Type':'application/json',
                'X-Reverie-Action-Key':self.key_id,'X-Reverie-Action-Signature':signature})
            response=conn.getresponse()
            if response.status in (400,403,404,409,413,429):
                raise HostActionRefused(response.status)
            if response.status!=200:
                raise HostActionUnconfirmed('Host response unconfirmed')
            raw=response.read(MAX_RESPONSE+1)
            if len(raw)>MAX_RESPONSE:
                raise HostActionUnconfirmed('Host response unconfirmed')
            result=json.loads(raw)
            if not isinstance(result,dict) or set(result)!={'success','data'} or result['success'] is not True:
                raise HostActionUnconfirmed('Host response unconfirmed')
            transport.remaining()
            return result['data']
        except (OSError,http.client.HTTPException,json.JSONDecodeError,UnicodeError) as error:
            raise HostActionUnconfirmed('Host response unconfirmed') from error
        finally:
            conn.close()
            transport.close()


class ActionHTTPServer:
    def __init__(self,path,envelope,peer_uids):
        path=Path(path)
        parent=path.parent.lstat()
        if (not path.is_absolute() or path.parent.resolve()!=path.parent or
            not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=os.getuid() or
            parent.st_mode&0o077):
            raise ValueError('Host action socket directory must be private and owned')
        # Never unlink an arbitrary existing path or steal a running service's socket.
        if path.exists() or path.is_symlink():
            raise ValueError('Host action socket already exists')
        allowed=frozenset(peer_uids)
        if not allowed or any(type(uid) is not int or uid<0 for uid in allowed):
            raise ValueError('Explicit host peer UIDs required')
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_POST(self):
                try:
                    uid=struct.unpack('3i',self.connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]
                    if uid not in allowed:
                        self.send_error(403);return
                    if self.path!=ENDPOINT or self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length',[]))!=1:
                        self.send_error(400);return
                    length=int(self.headers['Content-Length'])
                    if not 0<length<=MAX_BODY:
                        self.send_error(413);return
                    body=self.rfile.read(length)
                    if len(body)!=length:
                        self.send_error(400);return
                    self.connection.check_deadline()
                    result=envelope.dispatch(body,self.headers.get('X-Reverie-Action-Key'),self.headers.get('X-Reverie-Action-Signature'))
                    raw=canonical({'success':True,'data':result}).encode()
                    if len(raw)>MAX_RESPONSE:
                        self.send_error(413);return
                    self.send_response(200);self.send_header('Content-Type','application/json')
                    self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
                except PermissionError:self.send_error(403)
                except (ValueError,KeyError,TypeError):self.send_error(400)
                except (OSError,http.client.HTTPException):self.close_connection=True
        class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
            daemon_threads=True
            slots=threading.BoundedSemaphore(8)
            def process_request(self,request,address):
                if not self.slots.acquire(blocking=False):
                    self.shutdown_request(request);return
                try:super().process_request(request,address)
                except BaseException:self.slots.release();raise
            def process_request_thread(self,request,address):
                try:super().process_request_thread(request,address)
                finally:self.slots.release()
            def get_request(self):
                conn,address=super().get_request()
                return DeadlineSocket(socket.AF_UNIX,fileno=conn.detach()),address
        self.path=path
        self.server=Server(str(path),Handler)
        path.chmod(0o600)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown();self.server.server_close();self.thread.join(2)
        self.path.unlink(missing_ok=True)
