"""Offline EID-stable resource profiles/CAS and pure broker-config staging.

No owner endpoint, host config writer, broker call, stop or recreation actor.
Canonical binding/ownership inputs require trusted current actor provenance.
"""
import copy,fcntl,hashlib,json,os,re,stat,secrets
from pathlib import Path
from .worker_resources import validate_resources,validate_session_resources,validate_resource_reload,policy_digest,SESSION
MAX_BYTES=131072
class Refusal(ValueError):pass
class CommitUncertain(Refusal):pass
def need(value,code):
 if not value:raise Refusal(code)
def exact(v,keys):need(type(v) is dict and set(v)==set(keys),'CLOSED_SCHEMA')
def integer(v):need(type(v) is int and 0<=v<=9007199254740991,'VERSION_TYPE')
def uid(v):need(type(v) is str and SESSION.fullmatch(v),'CANONICAL_UUID')
def encode(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def decode(raw):
 need(type(raw) is bytes and len(raw)<=MAX_BYTES,'STORE_BOUND')
 def pairs(rows):
  d={}
  for k,v in rows:need(k not in d,'DUPLICATE_KEY');d[k]=v
  return d
 return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(Refusal('NONFINITE_JSON')))
def binding(v,eid):
 exact(v,('employee_id','current_sid','target_sid','current_generation','target_generation'));uid(eid)
 need(v['employee_id']==eid,'EMPLOYEE_BINDING');uid(v['current_sid']);uid(v['target_sid'])
 for k in ('current_generation','target_generation'):integer(v[k]);need(v[k]>0,'GENERATION')
 need(v['target_generation']>=v['current_generation'],'GENERATION_REGRESSION')
def profile(v,eid):
 exact(v,('version','resources','binding'));integer(v['version']);need(v['version']>0,'PROFILE_VERSION');validate_resources(v['resources']);encode(v);binding(v['binding'],eid)
def document(v):
 exact(v,('schema','revision','profiles'));need(v['schema']=='reverie-employee-resource-profiles-v1','STORE_SCHEMA');integer(v['revision'])
 need(type(v['profiles']) is dict and len(v['profiles'])<=256,'PROFILE_COUNT')
 for eid,p in v['profiles'].items():uid(eid);profile(p,eid)
 need(len(encode(v))<=MAX_BYTES,'STORE_BOUND')
def checked_file(fd):
 st=os.fstat(fd);need(stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode)==0o600 and st.st_uid==os.geteuid() and st.st_nlink==1,'PRIVATE_STORE_FILE');return st

class ProfileStore:
 def __init__(self,directory):
  p=Path(directory);need(p.is_absolute() and '..' not in p.parts,'STORE_PATH')
  fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
  try:
   for name in p.parts[1:]:
    n=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd);os.close(fd);fd=n
   s=os.fstat(fd);need(s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o700,'PRIVATE_STORE_DIRECTORY')
   self.fd=fd;self.path=p;self.identity=(s.st_dev,s.st_ino);self.closed=False
  except BaseException:os.close(fd);raise
 def close(self):
  if not self.closed:os.close(self.fd);self.closed=True
 def _root(self):
  need(not self.closed,'STORE_CLOSED');s=self.path.stat(follow_symlinks=False);need(stat.S_ISDIR(s.st_mode) and (s.st_dev,s.st_ino)==self.identity and s.st_uid==os.geteuid() and stat.S_IMODE(s.st_mode)==0o700,'STORE_DIRECTORY_REBOUND')
 def _load(self):
  try:f=os.open('profiles.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=self.fd)
  except FileNotFoundError:return {'schema':'reverie-employee-resource-profiles-v1','revision':0,'profiles':{}}
  try:
   before=checked_file(f);data=bytearray()
   while True:
    part=os.read(f,MAX_BYTES+1-len(data))
    if not part:break
    data.extend(part);need(len(data)<=MAX_BYTES,'STORE_BOUND')
   after=checked_file(f);need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'STORE_CHANGED')
   v=decode(bytes(data));document(v);return v
  finally:os.close(f)
 def _locked(self,fn):
  self._root()
  try:
   f=os.open('profiles.lock',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,0o600,dir_fd=self.fd)
   try:os.fchmod(f,0o600)
   except BaseException:os.close(f);raise
  except FileExistsError:
   f=os.open('profiles.lock',os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=self.fd)
  try:
   checked_file(f);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);self._root()
   s=os.stat('profiles.lock',dir_fd=self.fd,follow_symlinks=False);need((s.st_dev,s.st_ino)==(os.fstat(f).st_dev,os.fstat(f).st_ino),'LOCK_REBOUND')
   return fn(self._load())
  finally:os.close(f)
 def snapshot(self):return self._locked(lambda v:copy.deepcopy(v))
 def put(self,eid,resources,canonical_binding,*,expected_revision,expected_profile_version,expected_binding):
  canonical_binding=decode(encode(canonical_binding));resources=decode(encode(resources));expected_binding=decode(encode(expected_binding))
  uid(eid);binding(canonical_binding,eid);validate_resources(resources);encode(resources);integer(expected_revision);integer(expected_profile_version)
  def update(v):
   need(v['revision']==expected_revision,'STALE_STORE_REVISION');old=v['profiles'].get(eid)
   need((old['version'] if old else 0)==expected_profile_version,'STALE_PROFILE_VERSION')
   need(encode(old['binding'] if old else None)==encode(expected_binding),'STALE_IDENTITY_BINDING')
   value=copy.deepcopy(v);value['revision']+=1;value['profiles'][eid]={'version':expected_profile_version+1,'resources':copy.deepcopy(resources),'binding':copy.deepcopy(canonical_binding)};document(value);raw=encode(value)
   self._root();name='.profiles-'+secrets.token_hex(16);out=None;committed=False
   try:
    out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=self.fd)
    os.fchmod(out,0o600);checked_file(out)
    with os.fdopen(out,'wb',closefd=True) as stream:out=None;stream.write(raw);stream.flush();os.fsync(stream.fileno())
    self._root();os.rename(name,'profiles.json',src_dir_fd=self.fd,dst_dir_fd=self.fd);committed=True;os.fsync(self.fd)
    self._root();need(encode(self._load())==raw,'COMMITTED_STORE_MISMATCH');self._root()
   except BaseException as error:
    if committed:
     if isinstance(error,OSError):
      error.add_note('COMMIT_OUTCOME_UNCERTAIN_RETAIN_EVIDENCE');raise
     raise CommitUncertain('COMMIT_OUTCOME_UNCERTAIN_RETAIN_EVIDENCE') from error
    raise
   finally:
    if out is not None:os.close(out)
    try:os.unlink(name,dir_fd=self.fd)
    except FileNotFoundError:pass
   return copy.deepcopy(value)
  return self._locked(update)
 def stage_config(self,config,eid,canonical_binding,*,expected_revision,expected_profile_version,sid_owners):
  """Return candidate only; never persists broker config or invokes reload/launch."""
  canonical_binding=decode(encode(canonical_binding));config=decode(encode(config));sid_owners=decode(encode(sid_owners))
  uid(eid);binding(canonical_binding,eid);integer(expected_revision);integer(expected_profile_version)
  def stage(v):
   need(v['revision']==expected_revision,'STALE_STORE_REVISION');p=v['profiles'].get(eid);need(p is not None,'PENDING_PROFILE_MISSING_NO_DEFAULT')
   need(p['version']==expected_profile_version and encode(p['binding'])==encode(canonical_binding),'STALE_PROFILE_OR_BINDING')
   need(type(sid_owners) is dict,'CANONICAL_SID_OWNERS_REQUIRED')
   for key in ('current_sid','target_sid'):need(sid_owners.get(canonical_binding[key])==eid,'SID_OWNER_MISMATCH')
   before=copy.deepcopy(config);validate_session_resources(before);after=copy.deepcopy(before)
   sid=canonical_binding['target_sid']
   # Both are projections of this locked canonical profile. Retain the target
   # SID projection for compatibility; later SIDs inherit the stable EID entry.
   after.setdefault('employeeResources',{})[eid]=copy.deepcopy(p['resources'])
   after.setdefault('sessionResources',{})[sid]=copy.deepcopy(p['resources']);validate_resource_reload(before,after)
   for other,policy in before.get('sessionResources',{}).items():
    if other!=sid:need(encode(after['sessionResources'][other])==encode(policy),'UNRELATED_POLICY_CHANGED')
   for other,policy in before.get('employeeResources',{}).items():
    if other!=eid:need(encode(after['employeeResources'][other])==encode(policy),'UNRELATED_EMPLOYEE_POLICY_CHANGED')
   self._root()
   return {'config':after,'target_sid':sid,'profile_version':p['version'],'store_revision':v['revision'],'effective_policy_sha256':policy_digest(after,sid),'profile_sha256':hashlib.sha256(encode(p)).hexdigest()}
  return self._locked(stage)
