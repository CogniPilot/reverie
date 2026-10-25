"""Private bounded Unix transport. Fixed host phone signer; JSON never supplies its own authority."""
import fcntl,hashlib,hmac,os,socket,socketserver,struct,threading,time,uuid
from pathlib import Path
from .ops_common import *
MAX_REQUEST=16*1024;MAX_RESPONSE=64*1024

def send(sock,body,end,maximum):
 require(len(body)<=maximum);sock.settimeout(max(.001,end-time.monotonic()));sock.sendall(struct.pack('!I',len(body))+body)
def receive(sock,end,maximum):
 def exact(n):
  data=bytearray()
  while len(data)<n:
   require(time.monotonic()<end);sock.settimeout(max(.001,end-time.monotonic()));part=sock.recv(n-len(data));require(part);data.extend(part)
  return bytes(data)
 n=struct.unpack('!I',exact(4))[0];require(0<n<=maximum);return exact(n)
def sign(key,body):return hmac.new(key,canonical(body),hashlib.sha256).hexdigest()
def envelope(key,body):return canonical({'body':body,'signature':sign(key,body)})
def verified(key,raw):
 value=strict_json(raw);shape(value,('body','signature'));require(isinstance(value['signature'],str) and hmac.compare_digest(sign(key,value['body']),value['signature']));return value['body']

class Client:
 """Host-only broker calls this with the phone's fixed SID; it is never installed with a key in a laptop."""
 def __init__(self,path,key,uid=None):self.path=str(path);self.key=key;self.uid=os.getuid() if uid is None else uid
 def call(self,session,command):
  require(UUID.fullmatch(session));body={'version':1,'issuedAt':int(time.time()),'nonce':str(uuid.uuid4()),'session':session,'command':command};end=time.monotonic()+5
  with socket.socket(socket.AF_UNIX) as connection:
   connection.settimeout(5);connection.connect(self.path);peer=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));require(peer[1]==self.uid,'custody-invalid')
   send(connection,envelope(self.key,body),end,MAX_REQUEST);reply=verified(self.key,receive(connection,end,MAX_RESPONSE));require(reply.get('nonce')==body['nonce']);return reply['response']

class Server:
 def __init__(self,path,key,ledger,core,peer_uid=None,custody=lambda:None):
  self.path=Path(path);private_directory(self.path.parent);require(not os.path.lexists(self.path),'custody-invalid');self.key=key;self.ledger=ledger;self.core=core;self.uid=os.getuid() if peer_uid is None else peer_uid;self.custody=custody;self.capacity=threading.BoundedSemaphore(8)
  outer=self
  class Handler(socketserver.BaseRequestHandler):
   def handle(self):
    if not outer.capacity.acquire(False):return
    end=time.monotonic()+5;nonce=None
    try:
     peer=struct.unpack('3i',self.request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));require(peer[1]==outer.uid,'unauthorized');outer.custody()
     body=verified(outer.key,receive(self.request,end,MAX_REQUEST));shape(body,('version','issuedAt','nonce','session','command'))
     require(type(body['version']) is int and body['version']==1 and type(body['issuedAt']) is int and abs(time.time()-body['issuedAt'])<=30)
     require(str(uuid.UUID(body['nonce']))==body['nonce']);nonce=body['nonce'];outer.ledger.nonce(nonce,body['issuedAt']+30)
     result=outer.core.dispatch(body['session'],body['command']);response={'success':True,'data':result}
    except Refusal as error:response={'success':False,'reason':error.reason}
    except Exception:response={'success':False,'reason':'audit-unavailable'}
    finally:
     try:send(self.request,envelope(outer.key,{'nonce':nonce,'response':response}),end,MAX_RESPONSE)
     except Exception:pass
     outer.capacity.release()
  class UDS(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
   daemon_threads=True;request_queue_size=8
  self.server=UDS(str(self.path),Handler);self.path.chmod(0o600);self.thread=None
 def start(self):self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();return self
 def serve_forever(self):self.server.serve_forever()
 def close(self):
  self.server.shutdown();self.server.server_close()
  if self.thread:self.thread.join(5)
  self.path.unlink(missing_ok=True)
