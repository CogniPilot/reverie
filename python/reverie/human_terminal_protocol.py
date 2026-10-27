"""Closed independent human-shell protocol, pure source component only.

No process/engine/socket/PTY operations or browser authentication implemented.
Canonical current metadata and clocks must come from fixed trusted composition.
"""
import copy,json,math,re,time
UUID=re.compile(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}')
HEX=re.compile(r'[0-9a-f]{64}')
REQUEST_KEYS={'schema','shellId','employeeId','sessionId','sessionGeneration','containerId','imageId','policyDigest','cols','rows','requestId','expiresAtEpochMs','authorizationRef'}
CURRENT_KEYS={'employeeId','sessionId','sessionGeneration','containerId','imageId','policyDigest','running','onVacation','desiredRunning','humanTerminalEntitled'}
BINDING_KEYS=('employeeId','sessionId','sessionGeneration','containerId','imageId','policyDigest')
MAX_REQUEST=8192;MAX_DEPTH=8;MAX_FRAME=16384;MAX_OUTPUT_FRAME=65536;MAX_TOTAL=16*1024**2;MAX_LIFETIME=3600;MAX_IDLE=900
HUMAN_LAUNCHER='/opt/reverie/human/bin/reverie-human-shell'
class Refusal(ValueError):pass
def need(ok,code):
 if not ok:raise Refusal(code)
def exact(v,keys):need(type(v) is dict and set(v)==set(keys),'CLOSED_SCHEMA')
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def decode(raw):
 need(type(raw) is bytes and len(raw)<=MAX_REQUEST,'REQUEST_BOUND')
 depth=0;quoted=False;escaped=False
 for byte in raw:
  if quoted:
   if escaped:escaped=False
   elif byte==92:escaped=True
   elif byte==34:quoted=False
  elif byte==34:quoted=True
  elif byte in (91,123):depth+=1;need(depth<=MAX_DEPTH,'REQUEST_DEPTH')
  elif byte in (93,125):depth-=1;need(depth>=0,'REQUEST_DEPTH')
 need(depth==0 and not quoted,'REQUEST_SYNTAX')
 def pairs(items):
  d={}
  for k,v in items:need(k not in d,'DUPLICATE_KEY');d[k]=v
  return d
 def integer_token(token):
  digits=token[1:] if token.startswith('-') else token
  need(len(digits)<=16 and digits.isascii() and digits.isdigit(),'INTEGER_TOKEN_BOUND')
  need(len(digits)<16 or digits<='9007199254740991','INTEGER_TOKEN_BOUND')
  return int(token)
 try:
  return json.loads(raw,object_pairs_hook=pairs,parse_int=integer_token,
                    parse_constant=lambda _:(_ for _ in ()).throw(Refusal('NONFINITE_JSON')))
 except Refusal:raise
 except (ValueError,UnicodeDecodeError,OverflowError) as error:
  raise Refusal('MALFORMED_PROTOCOL_JSON') from error
def size(cols,rows):need(type(cols) is int and 2<=cols<=300 and type(rows) is int and 2<=rows<=120,'RESIZE_BOUND')
def identities(value):
 for key in ('employeeId','sessionId'):need(type(value[key]) is str and UUID.fullmatch(value[key]),'CANONICAL_ID')
 need(type(value['sessionGeneration']) is int and 1<=value['sessionGeneration']<=9007199254740991,'GENERATION')
 for key in ('containerId','policyDigest'):need(type(value[key]) is str and HEX.fullmatch(value[key]),'EXACT_IDENTITY')
 need(type(value['imageId']) is str and re.fullmatch(r'sha256:[0-9a-f]{64}',value['imageId']),'EXACT_IMAGE')
def validate_request(value):
 exact(value,REQUEST_KEYS);need(value['schema']=='reverie-human-shell-v2','SHELL_SCHEMA')
 need(len(canonical(value))<=MAX_REQUEST,'REQUEST_BOUND')
 for key in ('requestId','authorizationRef'):need(type(value[key]) is str and UUID.fullmatch(value[key]),'SERVER_REFERENCE')
 need(type(value['expiresAtEpochMs']) is int and 0<value['expiresAtEpochMs']<=9007199254740991,'AUTH_EXPIRY_TYPE')
 need(type(value['shellId']) is str and UUID.fullmatch(value['shellId']),'SHELL_ID');identities(value);size(value['cols'],value['rows'])
 return copy.deepcopy(value)
def bind_current(request,current):
 request=validate_request(request);exact(current,CURRENT_KEYS);identities(current)
 for key in ('running','onVacation','desiredRunning','humanTerminalEntitled'):need(type(current[key]) is bool,'CURRENT_STATE_TYPE')
 need(current['running'] and not current['onVacation'] and current['desiredRunning'] and current['humanTerminalEntitled'],'LAPTOP_UNAVAILABLE')
 need(canonical({k:request[k] for k in BINDING_KEYS})==canonical({k:current[k] for k in BINDING_KEYS}),'LAPTOP_BINDING_DRIFT')
 return copy.deepcopy(current)
def capability_check(capability,operation,request):
 need(capability is not None,'PROTECTED_OWNER_CAPABILITY_UNAVAILABLE')
 # Fixed protected issuer/storage/peer verifier port, NEVER selected by wire.
 # No implementation provided; bool/receipt-shaped success cannot substitute.
 method=getattr(capability,operation,None);need(callable(method),'CAPABILITY_PORT_UNAVAILABLE')
 need(method(copy.deepcopy(request)) is None,'CAPABILITY_PORT_CONTRACT')

def exec_argv(request,current,*,capability=None):
 """Fixed argv only. Caller still MUST prove owner/toolkit/engine binding."""
 bind_current(request,current);capability_check(capability,'recheck',request)
 h='/home/agent/.human'
 return ['exec','-it','--user','agent','--workdir','/home/agent',
         '--env','TERM=xterm-256color','--env','COLORTERM=truecolor',
         '--env','XDG_CONFIG_HOME='+h+'/config','--env','XDG_DATA_HOME='+h+'/data',
         '--env','XDG_CACHE_HOME='+h+'/cache','--env','STARSHIP_CONFIG='+h+'/config/starship.toml',
         request['containerId'],HUMAN_LAUNCHER]

class Channel:
 def __init__(self,request,current,*,capability=None,clock=time.monotonic,wall_clock=time.time):
  self.request=validate_request(request);self.binding=bind_current(self.request,current);self.clock=clock;self.wall_clock=wall_clock;self.capability=capability
  self._expiry();capability_check(capability,'consume',self.request);self._expiry()
  self.started=self._now();self.last=self.started;self.sample=self.started;self.received=0;self.sent=0;self.closed=False;self.failure=None
 def _expiry(self):
  now=self.wall_clock();need(type(now) in (int,float) and math.isfinite(now) and now>=0,'WALL_CLOCK')
  remaining=self.request['expiresAtEpochMs']/1000-now
  need(0<remaining<=MAX_LIFETIME,'OWNER_AUTH_EXPIRED_OR_UNBOUNDED')
 def _now(self):
  value=self.clock();need(type(value) in (int,float) and math.isfinite(value) and value>=0,'MONOTONIC_CLOCK');return value
 def close(self,reason='CLOSED'):
  self.closed=True
  if self.failure is None:self.failure=reason
 def _check(self,current):
  need(not self.closed,'SHELL_CLOSED');self._expiry();capability_check(self.capability,'recheck',self.request);self._expiry();now=self._now();need(now>=self.sample,'CLOCK_REGRESSION');self.sample=now
  need(now-self.started<MAX_LIFETIME and now-self.last<MAX_IDLE,'SHELL_EXPIRED')
  value=bind_current(self.request,current);need(canonical(value)==canonical(self.binding),'SHELL_STATE_DRIFT');return now
 def receive(self,kind,payload,current):
  try:
   now=self._check(current);need(type(payload) is bytes and len(payload)<=MAX_FRAME,'FRAME_BOUND')
   if kind==b'I':
    need(self.received+len(payload)<=MAX_TOTAL,'INPUT_BUDGET');self.received+=len(payload);result=('input',payload)
   elif kind==b'R':
    value=decode(payload);need(type(value) is list and len(value)==2,'RESIZE_SCHEMA');size(*value);result=('resize',tuple(value))
   elif kind==b'Q':
    need(payload==b'','CLOSE_FRAME');self.close();return ('close',None)
   else:raise Refusal('UNKNOWN_FRAME')
   self.last=now;return result
  except BaseException as error:self.close(type(error).__name__);raise
 def output(self,payload,current):
  try:
   self._check(current);need(type(payload) is bytes and len(payload)<=MAX_OUTPUT_FRAME,'OUTPUT_FRAME_BOUND')
   need(self.sent+len(payload)<=MAX_TOTAL,'OUTPUT_BUDGET');self.sent+=len(payload)
   # Output does not extend client-idle timeout or absolute lifetime.
   return payload
  except BaseException as error:self.close(type(error).__name__);raise
