"""OPS wire primitives and host-only custody. No effects or grants are inferred."""
import datetime,hashlib,json,os,re,stat
from pathlib import Path
ID=re.compile(r'[a-z0-9][a-z0-9-]{0,95}')
UUID=re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
SHA=re.compile(r'sha256:[0-9a-f]{64}')
ACTIONS=('reverie.ops.status','reverie.ops.inspect','reverie.ops.selftest.run','reverie.ops.website.restart','reverie.ops.prune.observe')
EFFECTS=ACTIONS[2:]
REASONS={'none','unauthorized','stable-identity-unavailable','unsupported-platform','adapter-unavailable','adapter-unhealthy','custody-invalid','stale-policy','stale-capability','stale-resource','unreviewed-artifact','expired-grant','revoked-grant','resource-busy','idempotency-conflict','unknown-effect','verification-failed','selftest-failed','preflight-failed','invalid-request','audit-unavailable','reconciliation-required','not-installed'}
ZERO='sha256:'+'0'*64
class Refusal(Exception):
 def __init__(self,reason='invalid-request'): self.reason=reason;super().__init__(reason)
def require(ok,reason='invalid-request'):
 if not ok:raise Refusal(reason)
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def digest(v):return 'sha256:'+hashlib.sha256(canonical(v)).hexdigest()
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
def strict_json(raw):
 def unique(pairs):
  d={}
  for k,v in pairs:
   require(k not in d);d[k]=v
  return d
 return json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(Refusal()))
def shape(v,keys):require(isinstance(v,dict) and set(v)==set(keys))
def identifier(v):require(isinstance(v,str) and ID.fullmatch(v));return v
def sha(v):require(isinstance(v,str) and SHA.fullmatch(v));return v
def command(v):
 require(isinstance(v,dict));base={'kind','version','requestId','action','resourceId'}
 require(v.get('kind')=='reverie.ops.command' and type(v.get('version')) is int and v['version']==1 and v.get('action') in ACTIONS)
 selector=set()
 if v['action']==ACTIONS[1]:
  require(('operationId' in v) != ('lookupIdempotencyKey' in v));selector={'operationId'} if 'operationId' in v else {'lookupIdempotencyKey'}
 required=base|selector|({'grantRef','idempotencyKey','artifact','expectedResourceGeneration','expectedCapabilityGeneration'} if v['action'] in EFFECTS else set())
 require(set(v)==required)
 for k in ('requestId','resourceId','operationId','lookupIdempotencyKey','idempotencyKey'):
  if k in v:identifier(v[k])
 if v['action'] in EFFECTS:
  shape(v['grantRef'],('grantId','policyGeneration'));identifier(v['grantRef']['grantId']);sha(v['grantRef']['policyGeneration'])
  shape(v['artifact'],('artifactId','digest','reviewId'));identifier(v['artifact']['artifactId']);identifier(v['artifact']['reviewId']);sha(v['artifact']['digest'])
  sha(v['expectedResourceGeneration']);sha(v['expectedCapabilityGeneration'])
 return strict_json(canonical(v))
def private_directory(path,uid=None,create=False):
 """Walk anchored nofollow descriptors. Never adopt/chown an exposed location."""
 path=Path(path);uid=os.getuid() if uid is None else uid
 require(all(ord(c)>=32 and ord(c)!=127 for c in str(path)),'custody-invalid')
 require(path.is_absolute() and path==Path(os.path.normpath(str(path))) and str(path)!='/', 'custody-invalid')
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
 try:
  for part in path.parts[1:]:
   try:n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
   except FileNotFoundError:
    require(create,'custody-invalid');os.mkdir(part,0o700,dir_fd=fd);n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
   os.close(fd);fd=n;s=os.fstat(fd)
   require(s.st_uid in (0,uid) and not s.st_mode&0o022,'custody-invalid')
  s=os.fstat(fd);require(s.st_uid==uid and not s.st_mode&0o077,'custody-invalid')
  return path
 finally:os.close(fd)
def private_read(path,limit=1024*1024,uid=None):
 path=Path(path);require(all(ord(c)>=32 and ord(c)!=127 for c in str(path)),'custody-invalid');private_directory(path.parent,uid=uid)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
 try:
  a=os.fstat(fd);require(stat.S_ISREG(a.st_mode) and a.st_uid==(os.getuid() if uid is None else uid) and a.st_nlink==1 and not a.st_mode&0o077 and a.st_size<=limit,'custody-invalid')
  data=os.read(fd,limit+1);b=os.fstat(fd)
  stamp=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
  require(len(data)<=limit and len(data)==a.st_size and stamp(a)==stamp(b),'custody-invalid');return data
 finally:os.close(fd)
def outside_mounts(path,mounts):
 require(isinstance(mounts,list) and mounts,'custody-invalid');p=Path(path).resolve()
 for value in mounts:
  m=Path(value);require(m.is_absolute(),'custody-invalid')
  for a,b in ((Path(path),m),(p,m.resolve())):
   require(not (a==b or a.is_relative_to(b) or b.is_relative_to(a)),'custody-invalid')

def command_digest(value,actor):
 normalized={k:v for k,v in value.items() if k not in ('requestId','idempotencyKey','operationId','lookupIdempotencyKey')}
 normalized['actor']={k:actor[k] for k in ('employeeId','companyId')}
 return 'sha256:'+hashlib.sha256(b'reverie.ops.command.v1\0'+canonical(normalized)).hexdigest()
