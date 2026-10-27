"""Closed owner-selected fixed browser-job configuration. No grants/effects on import.

This is configuration, never a caller's owner/UID assertion. A real canonical
owner cue, actual OfficeAPI caller, native custody and common capacity hold are
independently required by the private actor.
"""
from dataclasses import dataclass
import hashlib,json,os,re,stat
from pathlib import Path
from urllib.parse import urlsplit

class BrowserJobPolicyUnknown(ValueError):pass
def need(v,m):
    if not v:raise BrowserJobPolicyUnknown(m)
UUID=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',re.I)
SHA=re.compile(r'^[a-f0-9]{64}$')
MODULES={'browser_job_policy.py','browser_job_requests.py','browser_job_scope.py','host_job_scope.py','worker.py'}
def shape(v,keys):need(type(v)is dict and set(v)==set(keys),'CLOSED_BROWSER_JOB_POLICY')
def ident(v):need(type(v)is str and UUID.fullmatch(v),'BROWSER_JOB_ID')
def sha(v):need(type(v)is str and SHA.fullmatch(v),'BROWSER_JOB_SHA')
def counter(v,low,high):need(type(v)is int and low<=v<=high,'BROWSER_JOB_COUNTER')
def canonical_path(value,nix=False):
    need(type(value)is str and 0<len(value)<=4096 and not any(ord(x)<32 or ord(x)==127 for x in value),'BROWSER_JOB_PATH');p=Path(value)
    need(p.is_absolute()and '..'not in p.parts and str(p)==value and p.resolve()==p and(not nix or p.is_relative_to('/nix/store')),'BROWSER_JOB_PATH')
def pair(v,nix=False):shape(v,('path','sha256'));canonical_path(v['path'],nix);sha(v['sha256'])
def validate_document(p):
    shape(p,('version','enabled','jobKey','maxStarts','notBeforeMS','controlRoot','actor','ownerCue','targetURL','capture','manifest','profileSourceSHA256','nativeWorkerPath','hookSHA256','assets','hardware','tools','runner','driver','vulkanIcd','limits','pythonSource'))
    need(type(p['version'])is int and p['version']==1 and p['enabled']is True and p['jobKey']=='slam-office640'and type(p['maxStarts'])is int and p['maxStarts']==1,'FIXED_BROWSER_JOB_POLICY');counter(p['notBeforeMS'],0,9007199254740991);canonical_path(p['controlRoot'])
    actor=p['actor'];shape(actor,('employeeId','sessionId','sessionGeneration','owner','recipeSHA256'));ident(actor['employeeId']);ident(actor['sessionId']);counter(actor['sessionGeneration'],1,9007199254740991);need(actor['owner']is None or(type(actor['owner'])is str and len(actor['owner'])<=100),'BROWSER_JOB_OWNER_SCOPE');sha(actor['recipeSHA256'])
    cue=p['ownerCue'];shape(cue,('roomId','messageId','sha256'));ident(cue['roomId']);ident(cue['messageId']);sha(cue['sha256'])
    target=urlsplit(p['targetURL']);need(target.scheme=='https'and target.hostname and '.'in target.hostname and not target.username and not target.password and not target.port and not target.query and not target.fragment and target.path.startswith('/')and target.path.endswith('/')and '%'not in target.path,'FIXED_PUBLIC_TARGET')
    pair(p['capture']);pair(p['manifest']);pair(p['runner'],True);pair(p['driver'],True);pair(p['vulkanIcd'],True)
    need(Path(p['runner']['path']).parent==Path(p['driver']['path']).parent and Path(p['runner']['path']).name=='slam-job-run.mjs'and Path(p['driver']['path']).name=='slam-driver.mjs','FIXED_DRIVER_GRAPH')
    sha(p['profileSourceSHA256']);sha(p['hookSHA256']);worker=p['nativeWorkerPath'];need(type(worker)is str and worker.startswith(target.path)and worker.endswith('.js')and '%'not in worker and '\\'not in worker and '..'not in Path(worker).parts,'FIXED_NATIVE_WORKER')
    assets=p['assets'];need(type(assets)is dict and 1<=len(assets)<=512 and worker in assets,'PUBLIC_ASSET_ALLOWLIST')
    for name,value in assets.items():
        need(type(name)is str and name.startswith(target.path)and '%'not in name and '\\'not in name and '..'not in Path(name).parts and not any(c in name for c in('?', '#','\0')),'PUBLIC_ASSET_PATH');shape(value,('sha256','maxBytes','requiredForCapture','compilerRevision')if type(value)is dict and 'compilerRevision'in value else('sha256','maxBytes','requiredForCapture'));sha(value['sha256']);counter(value['maxBytes'],1,134217728);need(type(value['requiredForCapture'])is bool,'PUBLIC_ASSET_REQUIRED_FLAG')
    versioned={name:value['compilerRevision']for name,value in assets.items()if 'compilerRevision'in value}
    if versioned:
        need(set(versioned)=={target.path+'vendor/rumoca/rumoca_bind_wasm.js',target.path+'vendor/rumoca/rumoca_bind_wasm_bg.wasm'}and all(type(v)is str and re.fullmatch('[a-f0-9]{40}',v)for v in versioned.values())and len(set(versioned.values()))==1 and all(assets[name]['requiredForCapture']is True for name in versioned),'FIXED_COMPILER_REVISION_PAIR')
    hardware=p['hardware'];shape(hardware,('uuid','vendorId','deviceId','driverVersion','rendererSHA256'));need(type(hardware['uuid'])is str and re.fullmatch(r'GPU-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',hardware['uuid']),'CANONICAL_GPU_UUID');counter(hardware['vendorId'],1,65535);counter(hardware['deviceId'],1,65535);need(type(hardware['driverVersion'])is str and re.fullmatch(r'\d+(?:\.\d+)+',hardware['driverVersion']),'FIXED_GPU_DRIVER');sha(hardware['rendererSHA256'])
    tools=p['tools'];shape(tools,('node','chromium','nvidiaSMI','systemctl','systemdRun','taskset'))
    for value in tools.values():pair(value,True)
    limits=p['limits'];shape(limits,('memoryBytes','pids','cpuSet','setupSeconds','captureSeconds','runtimeSeconds','stopSeconds','outerSeconds','outputBytes','hostReserveMiB'))
    counter(limits['memoryBytes'],512*1024**2,16*1024**3);need(limits['memoryBytes']%1048576==0,'MIB_JOB_LIMIT');counter(limits['pids'],16,512);counter(limits['hostReserveMiB'],1,1048576)
    cpus=limits['cpuSet'];need(type(cpus)is list and 1<=len(cpus)<=8 and all(type(c)is int and c>=0 for c in cpus)and len(set(cpus))==len(cpus),'PRIVATE_JOB_CPU_SET')
    for k,v in(('setupSeconds',180),('captureSeconds',1200),('runtimeSeconds',1380),('stopSeconds',30),('outerSeconds',1440),('outputBytes',268435456)):need(type(limits[k])is int and limits[k]==v,'FIXED_JOB_ENVELOPE')
    shape(p['pythonSource'],MODULES)
    for value in p['pythonSource'].values():sha(value)
    return p

def _private(path):
    canonical_path(str(path));fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        a=os.fstat(fd);stamp=lambda v:(v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns,v.st_ctime_ns)
        need(stat.S_ISREG(a.st_mode)and a.st_uid==os.getuid()and a.st_nlink==1 and stat.S_IMODE(a.st_mode)==0o600 and a.st_size<=1048576,'PRIVATE_JOB_POLICY_CUSTODY');raw=bytearray()
        while len(raw)<=1048576:
            part=os.read(fd,min(65536,1048577-len(raw)))
            if not part:break
            raw.extend(part)
        need(len(raw)==a.st_size and stamp(a)==stamp(os.fstat(fd))==stamp(Path(path).lstat()),'PRIVATE_JOB_POLICY_CHANGED');return bytes(raw)
    finally:os.close(fd)
def _parse(raw):
    def unique(items):
        value={}
        for k,v in items:need(k not in value,'DUPLICATE_JOB_POLICY_KEY');value[k]=v
        return value
    return validate_document(json.loads(raw.decode('utf-8'),object_pairs_hook=unique))
@dataclass(frozen=True)
class BrowserJobPolicy:
    path:Path
    raw:bytes
    sha256:str
    @property
    def document(self):return _parse(self.raw)

def load_browser_job_policy(config):
    value=config.get('browserJobPolicy')
    if value is None:return None
    canonical_path(value);path=Path(value);raw=_private(path);_parse(raw);return BrowserJobPolicy(path,raw,hashlib.sha256(raw).hexdigest())
