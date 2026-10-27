"""Opaque one-use human-shell ledger, offline owned storage only.

Fixed verified-owner/same-origin issuer/current-target port is REQUIRED, absent
by default. This module supplies no production permission, socket or shell.
"""
import copy,fcntl,hashlib,hmac,json,math,os,secrets,stat,time,uuid,sys
from pathlib import Path
if __package__:
 from . import human_terminal_protocol as protocol
else:
 import human_terminal_protocol as protocol
MAX_STORE=131072;MAX_ENTRIES=128;MAX_REVISION=9007199254740991
class Refusal(ValueError):pass
class CommitUncertain(Refusal):pass
def need(v,code):
 if not v:raise Refusal(code)
def exact(v,keys):need(type(v) is dict and set(v)==set(keys),'LEDGER_SCHEMA')
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def digest(v):return hashlib.sha256(canonical(v)).hexdigest()
def hex64(v):need(type(v) is str and protocol.HEX.fullmatch(v),'DIGEST_TYPE')
def revision(v):need(type(v) is int and 0<=v<=MAX_REVISION,'REVISION_TYPE')
def parse(raw):
 need(type(raw) is bytes and len(raw)<=MAX_STORE,'LEDGER_BOUND')
 def pairs(rows):
  d={}
  for k,v in rows:need(k not in d,'DUPLICATE_LEDGER_KEY');d[k]=v
  return d
 def integer(token):
  need(not token.startswith('-') and (len(token)<16 or len(token)==16 and token<='9007199254740991'),'INTEGER_BOUND')
  return int(token)
 try:return json.loads(raw,object_pairs_hook=pairs,parse_int=integer,parse_constant=lambda _:(_ for _ in ()).throw(Refusal('NONFINITE_LEDGER')))
 except Refusal:raise
 except (ValueError,RecursionError,UnicodeError) as e:raise Refusal('MALFORMED_LEDGER') from e

def document(v):
 exact(v,('schema','revision','clockFloorMs','entries'));need(v['schema']=='reverie-owner-shell-capabilities-v1','LEDGER_VERSION');revision(v['revision']);revision(v['clockFloorMs'])
 need(type(v['entries']) is dict and len(v['entries'])<=MAX_ENTRIES,'LEDGER_ENTRY_BOUND')
 for reference,e in v['entries'].items():
  need(type(reference) is str and protocol.UUID.fullmatch(reference),'REFERENCE_TYPE')
  exact(e,('request','ownerScopeDigest','proof_sha256','state','consumerDigest','issue_revision','consume_revision','revoke_revision'))
  protocol.validate_request(e['request']);need(e['request']['authorizationRef']==reference,'REFERENCE_BINDING');hex64(e['ownerScopeDigest']);hex64(e['proof_sha256'])
  need(e['state'] in ('ISSUED','CONSUMED','REVOKED'),'ENTRY_STATE')
  revision(e['issue_revision']);need(0<e['issue_revision']<=v['revision'],'ISSUE_REVISION')
  if e['consumerDigest'] is None:need(e['consume_revision'] is None,'CONSUME_BINDING')
  else:
   hex64(e['consumerDigest']);revision(e['consume_revision']);need(e['issue_revision']<e['consume_revision']<=v['revision'],'CONSUME_REVISION')
  need((e['state']!='CONSUMED' or e['consumerDigest'] is not None) and (e['state']!='ISSUED' or e['consumerDigest'] is None),'CONSUMER_STATE')
  if e['state']=='REVOKED':
   revision(e['revoke_revision']);need((e['consume_revision'] or e['issue_revision'])<e['revoke_revision']<=v['revision'],'REVOKE_REVISION')
  else:need(e['revoke_revision'] is None,'REVOKE_STATE')
 need(len(canonical(v))<=MAX_STORE,'LEDGER_BOUND')

def private_file(fd):
 s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1,'PRIVATE_LEDGER_FILE');return s
def stamp(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def open_directory(path):
 path=Path(path);need(path.is_absolute() and '..' not in path.parts,'LEDGER_PATH');fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
 try:
  for part in path.parts[1:]:
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd);os.close(fd);fd=child
  return fd
 except BaseException:os.close(fd);raise

class CapabilityLedger:
 def __init__(self,directory,*,issuer=None,peer_verifier=None,clock=time.time):
  self.path=Path(directory);self.fd=open_directory(self.path);self.closed=False;self.issuer=issuer;self.peer=peer_verifier;self.clock=clock;self.clock_highwater=None;self.active_lock=None;self.operation_marker=None
  try:
   s=os.fstat(self.fd);self.identity=(s.st_dev,s.st_ino);self._root()
  except BaseException:self.close();raise
 def close(self):
  if not self.closed:os.close(self.fd);self.closed=True
 def _root(self):
  need(not self.closed,'LEDGER_CLOSED');fd=open_directory(self.path)
  try:
   s=os.fstat(fd);need((s.st_dev,s.st_ino)==self.identity and s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o700,'LEDGER_DIRECTORY_REBOUND')
  finally:os.close(fd)
  if self.active_lock is not None:
   s=os.stat('capabilities.lock',dir_fd=self.fd,follow_symlinks=False)
   need((s.st_dev,s.st_ino)==self.active_lock[1] and s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1,'LEDGER_LOCK_REBOUND')
 def _now_ms(self):
  n=self.clock();need(type(n) in (int,float) and math.isfinite(n) and 0<=n<=MAX_REVISION/1000,'CLOCK_TYPE');value=int(n*1000)
  need(self.clock_highwater is None or value>=self.clock_highwater,'CLOCK_ROLLBACK');self.clock_highwater=value;return value
 def _owner(self):
  need(self.issuer is not None,'PROTECTED_ISSUER_UNAVAILABLE')
  method=getattr(self.issuer,'assert_current_owner_same_origin',None);need(callable(method),'PROTECTED_ISSUER_UNAVAILABLE')
  scope=method();hex64(scope);return scope
 def _context(self,request,scope):
  need(self._owner()==scope,'OWNER_SCOPE_CHANGED')
  target=getattr(self.issuer,'canonical_target',None);need(callable(target),'CANONICAL_TARGET_UNAVAILABLE')
  protocol.bind_current(request,target())
  need(0<request['expiresAtEpochMs']-self._now_ms()<=protocol.MAX_LIFETIME*1000,'CAPABILITY_EXPIRED')
 def _read(self):
  try:fd=os.open('capabilities.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=self.fd)
  except FileNotFoundError:return {'schema':'reverie-owner-shell-capabilities-v1','revision':0,'clockFloorMs':0,'entries':{}}
  try:
   before=private_file(fd);data=bytearray()
   while True:
    part=os.read(fd,MAX_STORE+1-len(data))
    if not part:break
    data.extend(part);need(len(data)<=MAX_STORE,'LEDGER_BOUND')
   need(stamp(before)==stamp(private_file(fd)),'LEDGER_READ_CHANGED')
   named=os.stat('capabilities.json',dir_fd=self.fd,follow_symlinks=False);need(stamp(named)==stamp(before),'LEDGER_FILE_REBOUND')
   v=parse(bytes(data));document(v);return v
  finally:os.close(fd)
 def _locked(self,fn):
  self._root()
  try:
   fd=os.open('capabilities.lock',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,0o600,dir_fd=self.fd)
   try:os.fchmod(fd,0o600)
   except BaseException:os.close(fd);raise
  except FileExistsError:fd=os.open('capabilities.lock',os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=self.fd)
  token=object();claimed=False;marker={'committed':False}
  try:
   private_file(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);self._root()
   s=os.stat('capabilities.lock',dir_fd=self.fd,follow_symlinks=False);need((s.st_dev,s.st_ino)==(os.fstat(fd).st_dev,os.fstat(fd).st_ino),'LEDGER_LOCK_REBOUND')
   need(self.active_lock is None,'LEDGER_OPERATION_ACTIVE');self.active_lock=(token,(s.st_dev,s.st_ino));self.operation_marker=marker;claimed=True
   value=self._read();need(self._now_ms()>=value['clockFloorMs'],'DURABLE_CLOCK_ROLLBACK')
   result=fn(value);self._root();return result
  except BaseException as error:
   if marker['committed'] and not isinstance(error,CommitUncertain):raise CommitUncertain('CAPABILITY_COMMIT_UNCERTAIN_NO_RETRY') from error
   raise
  finally:
   if claimed and self.active_lock is not None and self.active_lock[0] is token:
    self.active_lock=None
    if self.operation_marker is marker:self.operation_marker=None
   primary=sys.exception()
   try:os.close(fd)
   except OSError as error:
    if primary is not None:primary.add_note('LEDGER_LOCK_CLOSE_FAILED_RETAIN_EVIDENCE')
    elif marker['committed']:raise CommitUncertain('CAPABILITY_COMMIT_UNCERTAIN_NO_RETRY') from error
    else:raise
 def _commit(self,value,guard):
  value['clockFloorMs']=self._now_ms();document(value);raw=canonical(value);name='.capability-'+secrets.token_hex(16);fd=None;committed=False
  try:
   self._root();guard();fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=self.fd);os.fchmod(fd,0o600);private_file(fd)
   with os.fdopen(fd,'wb') as f:fd=None;f.write(raw);f.flush();os.fsync(f.fileno())
   self._root();guard();os.rename(name,'capabilities.json',src_dir_fd=self.fd,dst_dir_fd=self.fd);committed=True
   if self.operation_marker is not None:self.operation_marker['committed']=True
   os.fsync(self.fd)
   self._root();need(canonical(self._read())==raw,'COMMITTED_LEDGER_MISMATCH');guard();self._root()
  except BaseException as e:
   if committed:raise CommitUncertain('CAPABILITY_COMMIT_UNCERTAIN_NO_RETRY') from e
   raise
  finally:
   primary=sys.exception();cleanup_error=None
   if fd is not None:
    try:os.close(fd)
    except OSError as e:cleanup_error=e
   try:os.unlink(name,dir_fd=self.fd)
   except FileNotFoundError:pass
   except OSError as e:cleanup_error=cleanup_error or e
   if cleanup_error is not None:
    if primary is not None:primary.add_note('LEDGER_CLEANUP_FAILED_RETAIN_EVIDENCE')
    else:raise cleanup_error
 def issue(self,*,cols,rows,lifetime_seconds=300):
  protocol.size(cols,rows);need(type(lifetime_seconds) is int and 1<=lifetime_seconds<=protocol.MAX_LIFETIME,'LIFETIME_BOUND')
  scope=self._owner();target=getattr(self.issuer,'canonical_target',None);need(callable(target),'CANONICAL_TARGET_UNAVAILABLE');current=target()
  # IDs/proof are server generated, never supplied by browser/employee name.
  request={k:current[k] for k in protocol.BINDING_KEYS};request.update(schema='reverie-human-shell-v2',requestId=str(uuid.uuid4()),shellId=str(uuid.uuid4()),authorizationRef=str(uuid.uuid4()),expiresAtEpochMs=self._now_ms()+lifetime_seconds*1000,cols=cols,rows=rows)
  protocol.validate_request(request);self._context(request,scope);proof=secrets.token_hex(32);proof_hash=hashlib.sha256(proof.encode()).hexdigest()
  def write(v):
   need(len(v['entries'])<MAX_ENTRIES and request['authorizationRef'] not in v['entries'],'CAPABILITY_LEDGER_FULL_OR_COLLISION')
   v['revision']+=1;v['entries'][request['authorizationRef']]={'request':request,'ownerScopeDigest':scope,'proof_sha256':proof_hash,'state':'ISSUED','consumerDigest':None,'issue_revision':v['revision'],'consume_revision':None,'revoke_revision':None}
   self._commit(v,lambda:self._context(request,scope));return {'request':copy.deepcopy(request),'proof':proof}
  return self._locked(write)
 def _entry(self,v,request,proof):
  protocol.validate_request(request);need(type(proof) is str and protocol.HEX.fullmatch(proof),'PROOF_TYPE')
  entry=v['entries'].get(request['authorizationRef']);need(entry is not None,'CAPABILITY_NOT_FOUND')
  need(hmac.compare_digest(entry['proof_sha256'],hashlib.sha256(proof.encode()).hexdigest()),'CAPABILITY_PROOF_REFUSED')
  need(canonical(entry['request'])==canonical(request),'CAPABILITY_REQUEST_DRIFT');self._context(request,entry['ownerScopeDigest']);return entry
 def _peer(self,consumer_digest):
  need(self.peer is not None,'PROTECTED_BROKER_PEER_VERIFIER_UNAVAILABLE')
  method=getattr(self.peer,'assert_current_peer',None);need(callable(method),'PROTECTED_BROKER_PEER_VERIFIER_UNAVAILABLE')
  need(method(consumer_digest) is None,'BROKER_PEER_VERIFIER_CONTRACT')
 def consume(self,request,proof,consumer_digest):
  request=copy.deepcopy(request);hex64(consumer_digest);self._peer(consumer_digest)
  def use(v):
   e=self._entry(v,request,proof);need(e['state']=='ISSUED','CAPABILITY_ALREADY_USED_OR_REVOKED');v['revision']+=1;e['state']='CONSUMED';e['consumerDigest']=consumer_digest;e['consume_revision']=v['revision']
   self._commit(v,lambda:(self._peer(consumer_digest),self._context(request,e['ownerScopeDigest'])));return None
  return self._locked(use)
 def recheck(self,request,proof,consumer_digest):
  request=copy.deepcopy(request);hex64(consumer_digest);self._peer(consumer_digest)
  def read(v):
   e=self._entry(v,request,proof);need(e['state']=='CONSUMED' and hmac.compare_digest(e['consumerDigest'] or '',consumer_digest),'CAPABILITY_NOT_CONSUMED_BY_THIS_SHELL');self._context(request,e['ownerScopeDigest'])
   v['revision']+=1;self._commit(v,lambda:(self._peer(consumer_digest),self._context(request,e['ownerScopeDigest'])));return None
  return self._locked(read)
 def _entry_owner(self,entry):
  need(self._owner()==entry['ownerScopeDigest'],'OWNER_SCOPE_CHANGED')
 def revoke(self,reference):
  need(type(reference) is str and protocol.UUID.fullmatch(reference),'REFERENCE_TYPE');self._owner()
  def revoke(v):
   e=v['entries'].get(reference);need(e is not None,'CAPABILITY_NOT_FOUND');self._entry_owner(e)
   if e['state']=='REVOKED':self._entry_owner(e);return None
   v['revision']+=1;e['state']='REVOKED';e['revoke_revision']=v['revision'];self._commit(v,lambda:self._entry_owner(e));self._entry_owner(e);return None
  return self._locked(revoke)
 def status(self,reference):
  """Owner-only metadata, never proof/hash/raw credential output."""
  self._owner()
  def read(v):
   e=v['entries'].get(reference);need(e is not None,'CAPABILITY_NOT_FOUND');self._entry_owner(e)
   result={'state':e['state'],'revision':v['revision'],'requestId':e['request']['requestId'],'shellId':e['request']['shellId'],'expiresAtEpochMs':e['request']['expiresAtEpochMs']}
   self._entry_owner(e);return result
  return self._locked(read)

class LedgerCapability:
 """Fixed one-transport shim; never resumes from an uncertain consume ACK."""
 def __init__(self,ledger,proof,consumer_digest):
  self.ledger=ledger;self.proof=proof;self.consumer=consumer_digest;self.consumed_request=None;self.failed=False
 def consume(self,request):
  need(not self.failed and self.consumed_request is None,'CAPABILITY_SHIM_ALREADY_USED_OR_UNCERTAIN')
  try:self.ledger.consume(request,self.proof,self.consumer)
  except BaseException:self.failed=True;raise
  self.consumed_request=digest(request)
 def recheck(self,request):
  need(not self.failed and self.consumed_request==digest(request),'CAPABILITY_SHIM_NOT_CONFIRMED')
  try:self.ledger.recheck(request,self.proof,self.consumer)
  except BaseException:self.failed=True;raise
