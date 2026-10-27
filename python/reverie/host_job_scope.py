"""Fixed native observer for an own transient host-job scope. Import is inert.

This module issues no authority and never starts/stops/signals a process. A
private actor supplies the fixed spec; capture and settlement require actual
systemd/kernel facts. Dicts, dataclass copies and TTLs cannot release a fence.
"""
from dataclasses import dataclass
from decimal import Decimal
import hashlib,math,os,re,stat,subprocess,threading,time
from pathlib import Path

class ScopeUnknown(RuntimeError):pass
def need(v,m):
    if not v:raise ScopeUnknown(m)
@dataclass(frozen=True)
class FixedHostJobSpec:
    job_id:str
    purpose:str
    policy_digest:str
    unit:str
    memory_bytes:int
    pids:int
    cpus:tuple
    runtime_seconds:int
    stop_seconds:int
    systemctl:str
    systemctl_sha256:str
    node_exe:str
    node_sha256:str
    node_entry:str
    node_entry_sha256:str
    working_directory:str
    def validate(self):
        need(type(self.job_id)is str and re.fullmatch('[a-f0-9]{32}',self.job_id),'JOB_ID')
        need(self.purpose=='fixed-public-browser'and self.unit=='reverie-gpu-job-'+self.job_id+'.scope','FIXED_JOB_SCOPE')
        need(type(self.policy_digest)is str and re.fullmatch('[a-f0-9]{64}',self.policy_digest),'POLICY_DIGEST')
        for value,maximum in((self.memory_bytes,16*1024**3),(self.pids,512),(self.runtime_seconds,3600),(self.stop_seconds,60)):
            need(type(value)is int and 0<value<=maximum,'FINITE_SCOPE_SPEC')
        need(type(self.cpus)is tuple and 1<=len(self.cpus)<=8 and all(type(x)is int and x>=0 for x in self.cpus)and len(set(self.cpus))==len(self.cpus),'PRIVATE_CPU_SPEC')
        for name in('systemctl_sha256','node_sha256','node_entry_sha256'):need(re.fullmatch('[a-f0-9]{64}',getattr(self,name)),'SOURCE_DIGEST')
        for name in('systemctl','node_exe','node_entry','working_directory'):
            p=Path(getattr(self,name));need(p.is_absolute()and '..'not in p.parts and p.resolve()==p,'CANONICAL_SCOPE_PATH')
        return self
    def metadata(self):
        return {name:(list(value)if name=='cpus'else value)for name,value in self.__dict__.items()}

@dataclass(frozen=True)
class ProcessBirth:
    pid:int
    start_tick:str
_MINT=object()
_REGISTRY={}
_REGISTRY_LOCK=threading.Lock()
class OwnedScopeBinding:
    __slots__=('_spec','_invocation','_group','_minted_at','_frozen')
    def __init__(self,token,spec,invocation,group):
        need(token is _MINT,'NATIVE_CAPTURE_REQUIRED');object.__setattr__(self,'_spec',spec);object.__setattr__(self,'_invocation',invocation);object.__setattr__(self,'_group',group);object.__setattr__(self,'_minted_at',time.time());object.__setattr__(self,'_frozen',True)
    def __setattr__(self,*_):raise TypeError('native binding is immutable')
    def __copy__(self):raise TypeError('native binding cannot be copied')
    def __deepcopy__(self,memo):raise TypeError('native binding cannot be copied')
    def __reduce__(self):raise TypeError('native binding cannot be serialized as authority')
    @property
    def spec(self):return self._spec
    @property
    def invocation_id(self):return self._invocation
    @property
    def control_group(self):return self._group
    def metadata(self):return {'kind':'OBSERVED_OWN_HOST_SCOPE','spec':self.spec.metadata(),'invocationId':self.invocation_id,'controlGroup':self.control_group,'observedAt':self._minted_at}

@dataclass(frozen=True)
class ScopeSettlement:
    spec:FixedHostJobSpec
    invocation_id:str
    control_group:str
    processes:tuple
    observed_at:float
    def metadata(self):return {'kind':'OBSERVED_HOST_SCOPE_SETTLED','spec':self.spec.metadata(),'invocationId':self.invocation_id,'controlGroup':self.control_group,'processes':[{'pid':x.pid,'startTick':x.start_tick}for x in self.processes],'observedAt':self.observed_at}

def _sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb')as f:
        while chunk:=f.read(1048576):h.update(chunk)
    return h.hexdigest()
def _program(path,expected,executable=True):
    p=Path(path);s=p.stat();need(p.is_relative_to('/nix/store')and p.resolve()==p and s.st_uid==0 and stat.S_ISREG(s.st_mode)and not s.st_mode&0o222 and s.st_size<=268435456 and(not executable or s.st_mode&0o111),'IMMUTABLE_SCOPE_TOOL');need(_sha(p)==expected,'SCOPE_TOOL_CHANGED')
def _read(path,maximum):
    with Path(path).open('rb')as f:raw=f.read(maximum+1)
    need(len(raw)<=maximum,'KERNEL_METADATA_BOUND');return raw.decode()
def _birth(pid):
    need(type(pid)is int and pid>1,'OWN_PROCESS_ID')
    try:
        row=_read(Path('/proc')/str(pid)/'stat',8192).rsplit(')',1)[1].split();return ProcessBirth(pid,row[19]),row[0],int(row[1])
    except FileNotFoundError:return None
    except (IndexError,ValueError)as error:raise ScopeUnknown('PROCESS_METADATA')from error

def _group(pid):
    rows=_read(Path('/proc')/str(pid)/'cgroup',4096).splitlines();need(len(rows)==1 and rows[0].startswith('0::/'),'UNIFIED_PROCESS_CGROUP');return rows[0][3:]
def _exe(pid):return str((Path('/proc')/str(pid)/'exe').resolve(strict=True))
def _cwd(pid):return str((Path('/proc')/str(pid)/'cwd').resolve(strict=True))
def _owner(pid):return (Path('/proc')/str(pid)).stat().st_uid

def _cpus(pid):
    text=_read(Path('/proc')/str(pid)/'status',65536);match=re.search(r'^Cpus_allowed_list:\s*([0-9,-]+)$',text,re.M);need(match,'PROCESS_CPU_FACTS');result=set()
    for part in match[1].split(','):
        values=part.split('-');need(len(values)in(1,2)and all(x.isdecimal()for x in values),'PROCESS_CPU_FACTS');a=int(values[0]);b=int(values[-1]);need(0<=a<=b and b-a<=64,'PROCESS_CPU_FACTS');result.update(range(a,b+1));need(len(result)<=64,'PROCESS_CPU_FACTS')
    return result

def _seconds(text):
    need(type(text)is str and 0<len(text)<=64,'FINITE_UNIT_TIME');parts=re.findall(r'([0-9]+(?:\.[0-9]+)?)(us|ms|s|min|h)',text);need(parts and ''.join(a+b for a,b in parts)==''.join(text.split()),'FINITE_UNIT_TIME');scale={'us':Decimal('.000001'),'ms':Decimal('.001'),'s':Decimal(1),'min':Decimal(60),'h':Decimal(3600)};return sum(Decimal(a)*scale[b]for a,b in parts)
def _query(spec,deadline):
    remain=min(3,deadline-time.monotonic());need(remain>0,'SCOPE_OBSERVATION_DEADLINE')
    env={k:os.environ[k]for k in('HOME','USER','LOGNAME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG')if k in os.environ};env['PATH']=str(Path(spec.systemctl).parent)
    r=subprocess.run([spec.systemctl,'--user','show',spec.unit,'--property=Id,InvocationID,LoadState,ActiveState,ControlGroup,RuntimeMaxUSec,TimeoutStopUSec,MemoryMax,MemorySwapMax,TasksMax'],env=env,capture_output=True,text=True,timeout=remain)
    need(len(r.stdout)<=16384,'UNIT_PROPERTY_BOUND');v={}
    for line in r.stdout.splitlines():
        k,separator,value=line.partition('=');need(separator and k not in v,'UNIT_PROPERTY_SCHEMA');v[k]=value
    need(v.get('Id')==spec.unit,'UNIT_ID_CHANGED');return r.returncode,v

def _empty(group):
    p=Path('/sys/fs/cgroup')/group.lstrip('/')
    try:
        events=dict(line.split()for line in _read(p/'cgroup.events',1024).splitlines());need(events.get('populated')in('0','1'),'CGROUP_POPULATION_UNKNOWN');return events['populated']=='0'
    except FileNotFoundError:return not p.exists()

def _deadline(maximum,external):
    now=time.monotonic()
    need(external is None or(type(external)in(int,float)and math.isfinite(external)),'FINITE_ABSOLUTE_SCOPE_DEADLINE')
    result=now+maximum if external is None else min(now+maximum,external)
    need(result>now,'SCOPE_OBSERVATION_DEADLINE');return result

def _ancestor_capacity(group,spec,deadline):
    """Actual scope charge is counted once; no sibling/worker credit exists."""
    root=Path('/sys/fs/cgroup');leaf=root/group.lstrip('/')
    need(len(leaf.parts)<=64,'SCOPE_ANCESTOR_BOUND')
    def counter(path):
        raw=_read(path,128).strip();need(raw.isascii()and raw.isdecimal()and len(raw)<=20,'SCOPE_ANCESTOR_COUNTER');return int(raw)
    own={name:counter(leaf/name)for name in('memory.current','pids.current')}
    need(own['memory.current']<=spec.memory_bytes and 0<own['pids.current']<=spec.pids,'SCOPE_OWN_CHARGE_UNKNOWN')
    current=leaf.parent
    while current.is_relative_to(root):
        need(time.monotonic()<deadline,'SCOPE_OBSERVATION_DEADLINE')
        for maximum,counter_name,request in(('memory.max','memory.current',spec.memory_bytes),('pids.max','pids.current',spec.pids)):
            try:raw=_read(current/maximum,128).strip()
            except FileNotFoundError:
                need(current==root,'SCOPE_ANCESTOR_FACTS_UNKNOWN');continue
            need(raw=='max'or(raw.isascii()and raw.isdecimal()and 0<int(raw)<2**64),'SCOPE_ANCESTOR_LIMIT')
            used=counter(current/counter_name);need(used>=own[counter_name],'SCOPE_ANCESTOR_COUNTER_CONFLICT')
            if raw!='max':need(used-own[counter_name]+request<=int(raw),'SCOPE_ANCESTOR_CAPACITY_EXHAUSTED')
        if current==root:break
        current=current.parent
    need({name:counter(leaf/name)for name in own}==own,'SCOPE_OWN_CHARGE_CHANGED')

class OwnScopeObserver:
    """Actual fixed producer. No engine command, caller callback or signal port."""
    def __init__(self):self._bindings={};self._lock=threading.RLock()
    def capture(self,spec,*,deadline=None):
        need(type(spec)is FixedHostJobSpec,'TYPED_SCOPE_SPEC_REQUIRED');spec.validate();_program(spec.systemctl,spec.systemctl_sha256);_program(spec.node_exe,spec.node_sha256);_program(spec.node_entry,spec.node_entry_sha256,False)
        deadline=_deadline(10,deadline);code,v=_query(spec,deadline)
        need(code==0 and v.get('ActiveState')=='active'and re.fullmatch('[a-f0-9]{32}',v.get('InvocationID','')),'ACTUAL_ACTIVE_SCOPE_REQUIRED')
        group=v.get('ControlGroup','');p=Path(group);need(p.is_absolute()and '..'not in p.parts and p.name==spec.unit,'ACTUAL_CGROUP_REQUIRED')
        need(_seconds(v.get('RuntimeMaxUSec'))==spec.runtime_seconds and _seconds(v.get('TimeoutStopUSec'))==spec.stop_seconds and v.get('MemoryMax')==str(spec.memory_bytes)and v.get('MemorySwapMax')=='0'and v.get('TasksMax')==str(spec.pids),'ACTUAL_SCOPE_LIMITS_DIFFER')
        root=Path('/sys/fs/cgroup')/group.lstrip('/')
        for name,value in(('memory.max',str(spec.memory_bytes)),('memory.swap.max','0'),('pids.max',str(spec.pids))):need(_read(root/name,128).strip()==value,'KERNEL_SCOPE_LIMITS_DIFFER')
        ids=_read(root/'cgroup.procs',32768).split();need(0<len(ids)<=spec.pids and len(set(ids))==len(ids)and all(x.isdecimal()for x in ids),'ACTUAL_SCOPE_PROCESSES_REQUIRED');seen=set();nodes=[]
        for text in ids:
            pid=int(text);before=_birth(pid)
            if before is None:continue
            ref,state,_=before;need(_group(pid)==group,'SCOPE_PROCESS_MOVED');seen.add(ref)
            try:exe=_exe(pid)
            except FileNotFoundError:continue
            if exe==spec.node_exe:
                argv=_read(Path('/proc')/text/'cmdline',16384).split('\0');need(argv[:2]==[spec.node_exe,spec.node_entry]and state not in('Z','X')and _cwd(pid)==spec.working_directory and _owner(pid)==os.getuid() and _cpus(pid)<=set(spec.cpus),'ACTUAL_NODE_BINDING_DIFFER');need(_birth(pid)==before,'ACTUAL_NODE_BIRTH_CHANGED');nodes.append(ref)
        need(len(nodes)==1,'EXACT_OWN_NODE_REQUIRED');_ancestor_capacity(group,spec,deadline);again=_query(spec,deadline)[1];need(again==v,'UNIT_CHANGED_DURING_CAPTURE')
        binding=OwnedScopeBinding(_MINT,spec,v['InvocationID'],group)
        with self._lock:self._bindings[id(binding)]={'binding':binding,'seen':seen,'client':None,'clientBirth':None}
        with _REGISTRY_LOCK:_REGISTRY[id(binding)]=(binding,self)
        return binding
    def _record(self,binding):
        need(type(binding)is OwnedScopeBinding and id(binding)in self._bindings and self._bindings[id(binding)]['binding']is binding,'UNREGISTERED_NATIVE_BINDING');return self._bindings[id(binding)]
    def attach_client(self,binding,client):
        with self._lock:
            record=self._record(binding);need(type(client)is subprocess.Popen and record['client']is None,'ACTUAL_SCOPE_CLIENT_REQUIRED');b=_birth(client.pid);need(b is not None and b[0].pid==client.pid and b[2]==os.getpid(),'DIRECT_OWN_SCOPE_CLIENT_REQUIRED');need(client.returncode is None and b[1]not in('Z','X'),'LIVE_DIRECT_SCOPE_CLIENT_REQUIRED');record['client']=client;record['clientBirth']=b[0]
    def observe_processes(self,binding,*,deadline=None):
        with self._lock:
            record=self._record(binding);v=_query(binding.spec,_deadline(5,deadline))[1];need(v.get('InvocationID')==binding.invocation_id and v.get('ControlGroup')==binding.control_group,'SCOPE_INCARNATION_CHANGED')
            root=Path('/sys/fs/cgroup')/binding.control_group.lstrip('/');ids=_read(root/'cgroup.procs',32768).split();need(len(ids)<=binding.spec.pids and all(x.isdecimal()for x in ids),'SCOPE_PROCESS_BOUND')
            for text in ids:
                ref=_birth(int(text))
                if ref is not None:need(_group(int(text))==binding.control_group,'PROCESS_CGROUP_DRIFT');record['seen'].add(ref[0]);need(len(record['seen'])<=8192,'TOTAL_PROCESS_CAPTURE_BOUND')
    def verify_settled(self,binding,*,deadline=None):
        with self._lock:
            record=self._record(binding);client=record['client'];need(client is not None and client.returncode is not None,'DIRECT_CLIENT_NOT_REAPED');deadline=_deadline(5,deadline)
            def terminal(v):
                same=v.get('InvocationID')==binding.invocation_id and v.get('ControlGroup')in(binding.control_group,'')
                gc=v.get('LoadState')=='not-found'and not v.get('InvocationID')and not v.get('ControlGroup')
                return v.get('ActiveState')in('inactive','failed')and(same or gc)
            before=_query(binding.spec,deadline)[1];need(terminal(before)and _empty(binding.control_group),'SCOPE_NOT_SETTLED')
            refs=record['seen']|{record['clientBirth']}
            for ref in refs:
                current=_birth(ref.pid);need(current is None or current[0]!=ref,'CAPTURED_PROCESS_STILL_EXISTS')
            after=_query(binding.spec,deadline)[1];need(terminal(after)and after==before and _empty(binding.control_group),'SCOPE_CHANGED_DURING_SETTLEMENT')
            return ScopeSettlement(binding.spec,binding.invocation_id,binding.control_group,tuple(sorted(refs,key=lambda r:(r.pid,r.start_tick))),time.time())

def verify_settled(binding,*,deadline=None):
    """Gate's fixed dispatch: only an actual registered producer can settle it."""
    with _REGISTRY_LOCK:item=_REGISTRY.get(id(binding))
    need(item is not None and item[0]is binding,'NATIVE_BINDING_NOT_REGISTERED');return item[1].verify_settled(binding,deadline=deadline)
