"""Explicit owner-local, bounded website quiescence around a strict broker upgrade.

No service daemon, remote API, privilege grant or replacement transport protocol.
Instance selection lives only in a private reviewed policy. The existing immutable
prepare/apply tool retains all config/company/store/stop/continuity protections.
"""
from pathlib import Path
import argparse
import hashlib
import json
import math
import os
import pwd
import select
import signal
import socket
import stat
import subprocess
import sys
import time
from types import SimpleNamespace

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = 'reverie'

from . import worker_service_transport_upgrade as T
from .worker_service_upgrade import need, private, stamp, encoded, digest, exclusive as _exclusive_bytes, directory_lock
from .worker_service import WorkerService
from .worker_cleanup import StopBudget, run_client

WORK_SECONDS = 240
RECOVERY_SECONDS = 270  # Below the existing ten-minute office outage grace.
RECOVERY_CLIENT_SECONDS = 15
POLICY_KEYS = {'version','expiresAtEpoch','entry','entrySHA256','tools','config','engine',
               'generation','website','selection','providers','companyProjectionSHA256',
               'directory','operation','sourcePins'}
OWNER_FIELDS = ('id','owner','sessionId','sessionGeneration','desiredRunning','onVacation','runtimeRecipe','permissions')


def exclusive(path, value):
    _exclusive_bytes(path, encoded(value))


def sha_file(path):
    with Path(path).open('rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()


def source_pin(path):
    path=Path(path);need(path.resolve()==path,'SOURCE_ALIAS')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid() and before.st_nlink==1 and
             not before.st_mode&0o022 and before.st_size<=2<<20,'SOURCE_CUSTODY')
        raw=bytearray()
        while part:=os.read(fd,min(65536,(2<<20)+1-len(raw))):
            raw.extend(part);need(len(raw)<=2<<20,'SOURCE_BOUND')
        after=os.fstat(fd);named=path.lstat()
        fields=lambda st:(st.st_dev,st.st_ino,st.st_mode,st.st_uid,st.st_nlink,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
        need(fields(before)==fields(after)==fields(named) and len(raw)==before.st_size,'SOURCE_CHANGED')
        return digest(raw)
    finally:os.close(fd)


def source_inventory(root):
    """Bounded canonical Python package graph; no symlink traversal/fallback."""
    root=Path(root);todo=[root];names=set();count=0;total=0
    while todo:
        directory=todo.pop();st=directory.lstat()
        need(stat.S_ISDIR(st.st_mode) and directory.resolve()==directory and st.st_uid==os.getuid() and
             stat.S_IMODE(st.st_mode)==0o700 and len(directory.relative_to(root).parts)<=8,'SOURCE_DIRECTORY')
        for path in directory.iterdir():
            count+=1;need(count<=4096,'SOURCE_INVENTORY_BOUND');info=path.lstat()
            if stat.S_ISDIR(info.st_mode):todo.append(path);continue
            need(stat.S_ISREG(info.st_mode) and path.suffix=='.py' and path.resolve()==path,'UNPINNED_SOURCE_ENTRY')
            total+=info.st_size;need(len(names)<512 and total<=32<<20,'SOURCE_INVENTORY_BOUND')
            names.add(str(path.relative_to(root)))
    return names


def verify_sources(source,pins):
    source=Path(source)
    need(type(pins)is dict and 1<=len(pins)<=512,'SOURCE_PINS')
    need(set(pins)==source_inventory(source),'UNDECLARED_LOCAL_SOURCE')
    for name,pin in pins.items():
        need(type(name)is str,'SOURCE_NAME');relative=Path(name)
        need(not relative.is_absolute() and '..'not in relative.parts and str(relative)==name and name.endswith('.py'),'SOURCE_NAME')
        need(source_pin(source/relative)==pin,'SOURCE_CHANGED')


def helper_diagnostic(raw):
    from .worker_service import _DIAGNOSTIC_REASONS, _TRANSPORT_DIAGNOSTIC_STAGES, _MANAGER_STAGES
    categories={'OBSERVATION_TIMEOUT','PATH_UNAVAILABLE','PATH_PERMISSION','EXCLUSIVE_PATH_EXISTS',
                'PATH_ALIAS','ATOMIC_FILESYSTEM_MISMATCH','IO_UNCONFIRMED','GUARD_CHECK_FAILED','OPERATION_UNCONFIRMED'}
    reasons=_DIAGNOSTIC_REASONS|{'Unlisted exception details withheld.',
            'A fixed observation/client deadline expired; existing attempt state is unchanged by diagnostics.'}
    for line in raw.decode('utf8',errors='replace').splitlines()[-4:]:
        try:value=json.loads(line)
        except (ValueError,TypeError):continue
        if (type(value)is dict and set(value) in ({'category','reason'},{'category','reason','stage'}) and
                type(value['category'])is str and type(value['reason'])is str and
                value['category']in categories and value['reason']in reasons and
                ('stage' not in value or (type(value['stage'])is str and value['stage'] in _TRANSPORT_DIAGNOSTIC_STAGES))):
            return value
        if (type(value)is dict and set(value) in (
                {'category','reason','managerStage','returncode'},
                {'category','reason','managerStage','returncode','stage'}) and
                value['category']=='OPERATION_UNCONFIRMED' and
                value['reason']=='Owner user-service manager operation failed' and
                type(value['managerStage'])is str and value['managerStage']in _MANAGER_STAGES.values() and
                type(value['returncode'])is int and -128<=value['returncode']<=255 and value['returncode']!=0 and
                ('stage' not in value or (type(value['stage'])is str and value['stage'] in _TRANSPORT_DIAGNOSTIC_STAGES))):
            return value
    return None


def policy_file(path, expected, *, recovery=False):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path, 'POLICY_PATH')
    raw = private(path, maximum=1<<20)
    need(type(expected) is str and len(expected)==64 and digest(raw)==expected,'POLICY_SHA')
    value = json.loads(raw)
    need(type(value) is dict and set(value)==POLICY_KEYS and type(value['version']) is int and value['version']==1,'POLICY_SCHEMA')
    need(type(value['expiresAtEpoch']) in (int,float) and math.isfinite(value['expiresAtEpoch']),'POLICY_WINDOW')
    if not recovery:need(time.time()<value['expiresAtEpoch']<=time.time()+1800,'POLICY_WINDOW')
    need(type(value['providers']) is list and 1<=len(value['providers'])<=512,'PROVIDER_BASELINE')
    pids=[p.get('pid') for p in value['providers']]
    need(all(type(pid)is int and pid>1 for pid in pids) and len(set(pids))==len(pids),'PROVIDER_BASELINE')
    need(set(value['tools'])=={'python','docker','systemctl','helper'},'FIXED_TOOLS')
    for role,tool in value['tools'].items():
        need(type(tool)is dict and set(tool)=={'path','sha256'},'TOOL_SCHEMA')
        p=Path(tool['path']);st=p.lstat()
        need(p.is_absolute() and p.resolve()==p and p.is_relative_to('/nix/store') and
             stat.S_ISREG(st.st_mode) and st.st_uid==0 and not st.st_mode&0o6222 and st.st_mode&0o111 and
             sha_file(p)==tool['sha256'],'IMMUTABLE_TOOL')
    entry=Path(value['entry']);st=entry.lstat()
    need(entry.resolve()==Path(__file__).resolve() and stat.S_ISREG(st.st_mode) and
         st.st_uid in (0,os.getuid()) and not st.st_mode&0o022 and sha_file(entry)==value['entrySHA256'],'ENTRY_SOURCE')
    need(set(value['config'])=={'path','sha256'} and set(value['selection'])=={'path','sha256'},'INPUT_SCHEMA')
    for key in ('config','selection'):
        need(digest(private(Path(value[key]['path'])))==value[key]['sha256'],'PRIVATE_INPUT_CHANGED')
    selected=json.loads(private(Path(value['selection']['path'])))
    need(selected=={'providerPIDs':sorted(pids)},'SELECTION_BASELINE')
    need(set(value['engine'])=={'endpoint','engineId'} and value['engine']['endpoint'].startswith('unix:///'),'LOCAL_ENGINE')
    w=value['website']
    import re
    need(type(w)is dict and set(w)=={'id','image','pid','startTick','startedAt'} and
         re.fullmatch('[a-f0-9]{64}',w['id']) and re.fullmatch('sha256:[a-f0-9]{64}',w['image']) and
         type(w['pid'])is int and w['pid']>1 and type(w['startTick'])is int and w['startTick']>0 and
         type(w['startedAt'])is str and 1<=len(w['startedAt'])<=100,'WEBSITE_BINDING')
    need(re.fullmatch('[a-f0-9]{64}',value['companyProjectionSHA256'])is not None,'OWNER_BASELINE')
    for name in ('directory','operation'):
        p=Path(value[name]);fd,_=T.R._directory(p,os.getuid());os.close(fd)
    source=Path(value['entry']).parent
    verify_sources(source,value['sourcePins'])
    need(value['sourcePins'].get(Path(__file__).name)==value['entrySHA256'],'ENTRY_PIN')
    for directory in (source,path.parent):
        fd,_=T.R._directory(directory,os.getuid());os.close(fd)
    need(value['directory']!=value['operation'],'DISTINCT_DIRECTORIES')
    return value


def website_binding(item):
    from .worker_gpu_preflight import _process
    state=item['State'];need(state['Running']is True and state['Pid']>1 and not state['Restarting'] and not state['OOMKilled'],'WEBSITE_NOT_RUNNING')
    process=_process(state['Pid'])
    return {'id':item['Id'],'image':item['Image'],'pid':state['Pid'],
            'startTick':process['startTick'],'startedAt':state['StartedAt']}


def website_fingerprint(item):
    # Docker may permute mount metadata without changing any grant. Preserve
    # complete records and duplicates, sorting only these set-like inventories.
    def ordered(values):
        need(type(values)is list and all(type(v)is dict for v in values),'WEBSITE_MOUNT_SCHEMA')
        return sorted(values,key=encoded)
    host=dict(item['HostConfig'])
    if host.get('Mounts')is not None:host['Mounts']=ordered(host['Mounts'])
    return digest(encoded({'Id':item['Id'],'Image':item['Image'],'Config':item['Config'],
                          'HostConfig':host,'Mounts':ordered(item['Mounts'])}))


def validate_plan(plan, policy, baseline, actual_sha):
    need(type(plan)is dict and set(plan)=={'kind','expiresAt','generation','selection','engine','protected','native','broker'},'PREPARED_PLAN_SCHEMA')
    need(plan['kind']==T.KIND and digest(encoded(plan))==actual_sha and time.time()<plan['expiresAt'],'PREPARED_PLAN_PIN')
    need(plan['generation']==policy['generation']==baseline['generation'],'PREPARED_GENERATION')
    need(plan['generation']['configSHA256']==policy['config']['sha256'],'PREPARED_CONFIG')
    for field in ('engine','protected','native','broker'):
        need(plan[field]==baseline[field],'PREPARED_'+field.upper())
    need(plan['selection']=={'providerPIDs':sorted(v['pid']for v in policy['providers'])},'PREPARED_SELECTION')



def process_group_row(pid):
    path=Path('/proc')/str(pid)
    with (path/'stat').open('rb') as stream: raw=stream.read(8193)
    need(len(raw)<=8192,'HELPER_PROCESS_METADATA_BOUND')
    fields=raw.rsplit(b')',1)[1].split()
    return {'pid':pid,'uid':path.stat().st_uid,'state':fields[0].decode(),
            'group':int(fields[2]),'session':int(fields[3]),'start':int(fields[19])}


class OwnedHelper:
    """Only the actual Popen child/session created here may be settled.

    waitid(WNOWAIT) keeps our direct child's PID allocated until all its group
    members are gone. No foreign process inspection/permission is a prerequisite.
    A forced cleanup is never a successful helper response.
    """
    def __init__(self,args,deadline,directory):
        self.deadline=deadline;self.settled=False;self.forced=False;self.cleanup_end=None
        self.args,self.directory=args,directory;self.child=None;self.birth=None;self.spawn_started=False;self.metadata={}

    def start(self):
        self.spawn_started=True
        self.child=subprocess.Popen(self.args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE,start_new_session=True,cwd=self.directory)
        self.birth=process_group_row(self.child.pid)
        need(self.birth['group']==self.birth['session']==self.child.pid,'HELPER_SESSION_IDENTITY')

    def exited(self):
        return os.waitid(os.P_PID,self.child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)

    def members(self):
        need(process_group_row(self.child.pid)==self.birth or
             all(process_group_row(self.child.pid)[k]==self.birth[k] for k in ('pid','uid','group','session','start')),
             'HELPER_PROCESS_IDENTITY_CHANGED')
        result=[];count=0
        for entry in Path('/proc').iterdir():
            if not entry.name.isdecimal():continue
            count+=1;need(count<=65536 and time.monotonic()<(self.cleanup_end or self.deadline),'PROCESS_CENSUS_BOUND')
            try:
                if entry.stat().st_uid!=os.getuid():continue
                row=process_group_row(int(entry.name))
            except (FileNotFoundError,ProcessLookupError):continue
            if row['group']==self.child.pid:
                need(row['session']==self.child.pid and row['start']>=self.birth['start'],'HELPER_GROUP_IDENTITY')
                if row['pid']!=self.child.pid:result.append(row)
        return result

    def settle(self):
        if self.settled:return True
        if self.child is None:return not self.spawn_started
        if self.birth is None:
            self.birth=process_group_row(self.child.pid)
            need(self.birth['group']==self.birth['session']==self.child.pid,'HELPER_SESSION_IDENTITY')
        if self.cleanup_end is None:self.cleanup_end=time.monotonic()+5
        try:
            natural=self.exited()is not None and not self.members()
            if not natural:
                self.forced=True
                os.killpg(self.child.pid,signal.SIGTERM)
                grace=min(self.cleanup_end,time.monotonic()+2)
                while time.monotonic()<grace and (self.exited()is None or self.members()):time.sleep(.01)
                if self.exited()is None or self.members():os.killpg(self.child.pid,signal.SIGKILL)
            while time.monotonic()<self.cleanup_end and (self.exited()is None or self.members()):time.sleep(.01)
            need(self.exited()is not None and not self.members(),'HELPER_GROUP_UNSETTLED')
            self.child.wait(timeout=.1) # Already waitid-confirmed exited; reap our direct child last.
            self.settled=True;return True
        finally:
            for pipe in (self.child.stdout,self.child.stderr):pipe.close()

    def run(self):
        buffers={}
        try:
            self.start()
            buffers={self.child.stdout:bytearray(),self.child.stderr:bytearray()}
            for pipe in buffers:os.set_blocking(pipe.fileno(),False)
            active=list(buffers)
            while active:
                left=self.deadline-time.monotonic();need(left>0,'HELPER_DEADLINE')
                ready,_,_=select.select(active,[],[],min(.05,left))
                for pipe in ready:
                    chunk=os.read(pipe.fileno(),65537)
                    need(len(buffers[pipe])+len(chunk)<=65536,'HELPER_OUTPUT_BOUND')
                    if chunk:buffers[pipe].extend(chunk)
                    else:active.remove(pipe)
                if self.exited()is not None and not ready:break
            while self.exited()is None and time.monotonic()<self.deadline:time.sleep(.01)
            need(self.exited()is not None,'HELPER_EXIT_UNKNOWN')
        finally:
            try:need(self.settle(),'HELPER_GROUP_UNSETTLED')
            finally:
                out=bytes(buffers.get(getattr(self.child,'stdout',None),b''));err=bytes(buffers.get(getattr(self.child,'stderr',None),b''))
                self.metadata={'exitCode':self.child.returncode if self.child else None,'settled':self.settled,'forcedCleanup':self.forced,
                               'stdoutBytes':len(out),'stdoutSHA256':digest(out),'stderrBytes':len(err),'stderrSHA256':digest(err),
                               'diagnostic':helper_diagnostic(err)}
        need(not self.forced and self.child.returncode==0,'HELPER_OUTCOME_UNCONFIRMED')
        return json.loads(buffers[self.child.stdout].decode())


class Ports:
    """Fixed native ports. No caller-supplied command list enters this boundary."""
    def __init__(self, policy, policy_path, policy_sha):
        self.p=policy;self.policy_path=Path(policy_path);self.policy_sha=policy_sha
        self.owner=SimpleNamespace(stopping=StopBudget(),owned_clients={},cleanup_uncertain=set())
        self.deadline=time.monotonic()+WORK_SECONDS;self.watchdog=None;self.active_helper=None
        uid=os.getuid();home=Path.home();runtime='/run/user/'+str(uid)
        # Per-process execution environment only; no installed env/config edit.
        allowed={'HOME':str(home),'USER':pwd.getpwuid(uid).pw_name,'PATH':':'.join(str(Path(v['path']).parent)for v in policy['tools'].values()),
                 'XDG_RUNTIME_DIR':runtime,'DBUS_SESSION_BUS_ADDRESS':'unix:path='+runtime+'/bus',
                 'DOCKER_HOST':policy['engine']['endpoint'],'DOCKER_CONTEXT':'','LANG':'C.UTF-8'}
        os.environ.clear();os.environ.update(allowed)
        self.service=WorkerService(policy['config']['path'],run=self.fixed_read)
        self.service.target_unit=lambda:Path(policy['generation']['newUnit']['path'])
        self.t=T.TransportUpgrade(self.service,policy['operation']);self.t.deadline=self.deadline;self.t.tools.deadline=self.deadline

    def command(self,args,timeout,limit=8<<20):
        left=min(timeout,self.deadline-time.monotonic());need(left>0,'CONTROLLER_DEADLINE')
        result=run_client(args,timeout=left,owner=self.owner,limit=limit)
        need(result.returncode==0 and not self.owner.owned_clients and not self.owner.cleanup_uncertain,'FIXED_CLIENT_UNCONFIRMED')
        return result

    def fixed_read(self,args,*,deadline=None):
        need(args and args[0]in('docker','systemctl'),'READ_ONLY_TOOL')
        if args[0]=='docker':
            need(args[1]in('info','ps','inspect','--host'),'READ_ONLY_ENGINE')
            if args[1]=='--host':need(args[2]==self.p['engine']['endpoint'] and args[3]in('info','ps','inspect'),'READ_ONLY_ENGINE')
        else:need(args[1:3]==['--user','show'],'READ_ONLY_MANAGER')
        return self.command([self.p['tools'][args[0]]['path'],*args[1:]],min(20,(deadline or self.deadline)-time.monotonic()))

    def inspect(self):
        data=self.command([self.p['tools']['docker']['path'],'--host',self.p['engine']['endpoint'],
                           'inspect',self.p['website']['id']],15).stdout
        rows=json.loads(data);need(type(rows)is list and len(rows)==1,'EXACT_WEBSITE_INSPECT')
        need(website_binding(rows[0])==self.p['website'],'WEBSITE_INCARNATION_CHANGED')
        return rows[0]

    def pause(self):
        self.command([self.p['tools']['docker']['path'],'--host',self.p['engine']['endpoint'],
                      'pause',self.p['website']['id']],15,65536)

    def unpause(self):
        # Recovery only needs the SAME incarnation, even if an independent
        # config observation became unknown. Never substitute a name/new CID.
        self.deadline=max(self.deadline,time.monotonic()+RECOVERY_CLIENT_SECONDS)
        item=self.inspect()
        if item['State']['Paused']:
            self.command([self.p['tools']['docker']['path'],'--host',self.p['engine']['endpoint'],
                          'unpause',self.p['website']['id']],RECOVERY_CLIENT_SECONDS,65536)
        need(self.inspect()['State']['Paused']is False,'UNPAUSE_UNCONFIRMED')

    def snapshot(self):
        from .worker_storage import read_metadata
        generation=self.t.tools.generation();need(generation==self.p['generation'],'GENERATION_CHANGED')
        engine=self.t.engine();need(engine['endpoint']==self.p['engine']['endpoint'] and engine['engineId']==self.p['engine']['engineId'],'ENGINE_CHANGED')
        config=T.load_config(self.service.config_path);gate=self.t._gate(config,engine)
        with gate.admission(deadline=self.deadline):
            self.t.idle(gate)
            # Shared native custody accounts for ALL configured and actual
            # mounts, including RO/broad/stopped binds and namespace aliases.
            controls={Path(self.p['directory']):Path(self.p['directory'])/'ATTEMPT.json',
                      self.policy_path.parent:self.policy_path,
                      Path(__file__).resolve().parent:Path(__file__).resolve(),
                      Path(self.p['operation']):Path(self.p['operation'])/'PLAN.json'}
            for directory,marker in controls.items():
                gate.native.custody(directory,marker,deadline=self.deadline)
            protected=self.t.protected(gate);broker=self.t.broker(generation['unit'])
            native=self.t.native(gate,{'providerPIDs':sorted(p['pid']for p in self.p['providers'])})
            company=read_metadata(Path(config['companyFile']),config['uid'])
            projection=sorted(({key:row.get(key)for key in OWNER_FIELDS}for row in company['employees']),key=lambda r:r['id'])
            need(digest(encoded(projection))==self.p['companyProjectionSHA256'],'OWNER_PROJECTION_CHANGED')
            need(native['providers']==self.p['providers'],'PROVIDER_BASELINE_CHANGED')
        observed={'generation':generation,'engine':engine,'protected':protected,'native':native,'broker':broker}
        self.t._terminal(observed,gate,running=broker)
        return observed

    def helper(self,action,plan_sha=None):
        need(action in('prepare','apply'),'FIXED_HELPER_ACTION')
        args=[self.p['tools']['helper']['path'],'--config',self.p['config']['path'],'--diagnostic',action+'-transport-upgrade','--operation',self.p['operation']]
        args+=['--selection',self.p['selection']['path']]if action=='prepare'else['--plan-sha256',plan_sha]
        remaining=self.p['expiresAtEpoch']-time.time();need(remaining>0,'POLICY_EXPIRED')
        self.active_helper=OwnedHelper(args,min(self.deadline,time.monotonic()+180,time.monotonic()+remaining),Path(self.p['directory']))
        try:return self.active_helper.run()
        finally:exclusive(Path(self.p['directory'])/('HELPER-'+action+'.json'),self.active_helper.metadata)

    def helper_settled(self):
        return self.active_helper is None or self.active_helper.settle()

    def prepared(self):return json.loads(private(Path(self.p['operation'])/'PLAN.json'))

    def arm(self):
        left,right=socket.socketpair();left.settimeout(5)
        args=[self.p['tools']['python']['path'],'-I','-B',self.p['entry'],'--watchdog-fd',str(right.fileno()),
              '--policy',str(self.policy_path),'--policy-sha256',self.policy_sha]
        try:
            child=subprocess.Popen(args,pass_fds=(right.fileno(),),start_new_session=True,
                                   stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            self.watchdog=(child,left);right.close()
            from .worker_gpu_preflight import _process
            born=_process(child.pid)
            exclusive(Path(self.p['directory'])/'WATCHDOG-STARTED.json',{'version':1,'pid':child.pid,'startTick':born['startTick']})
            need(left.recv(32)==b'ARMED\n','WATCHDOG_NOT_ARMED')
        except BaseException:
            right.close();left.close();raise

    def cancel(self):
        child,channel=self.watchdog;channel.sendall(b'CANCEL\n');channel.close()
        end=time.monotonic()+5
        while child.poll()is None and time.monotonic()<end:time.sleep(.01)
        need(child.poll()==0,'WATCHDOG_NOT_SETTLED')
        receipt=json.loads(private(Path(self.p['directory'])/'WATCHDOG.json'))
        need(receipt.get('state')=='CANCELLED_UNPAUSED','WATCHDOG_RECOVERY_USED_OR_UNKNOWN')

    def abandon(self):
        if self.watchdog is not None:self.watchdog[1].close() # EOF triggers fixed recovery.


def watchdog(policy,fd):
    """Separate finite process: only inspect/unpause fixed existing incarnation."""
    ports=Ports(policy, '', '')
    ports.deadline=time.monotonic()+RECOVERY_SECONDS+RECOVERY_CLIENT_SECONDS
    channel=socket.socket(fileno=fd)
    item=ports.inspect();need(item['State']['Paused']is False,'WATCHDOG_INITIAL_STATE')
    channel.sendall(b'ARMED\n');end=time.monotonic()+RECOVERY_SECONDS
    state='RECOVERY_UNCONFIRMED'
    try:
        ready,_,_=select.select([channel],[],[],max(0,end-time.monotonic()))
        data=channel.recv(32)if ready else b''
        if data==b'CANCEL\n' and ports.inspect()['State']['Paused']is False:
            state='CANCELLED_UNPAUSED'
        else:
            ports.unpause();state='RECOVERED_UNPAUSED'
    finally:
        channel.close()
        exclusive(Path(policy['directory'])/'WATCHDOG.json',{'version':1,'state':state,'websiteId':policy['website']['id']})


class Controller:
    def __init__(self,policy,ports):
        self.p,self.io=policy,ports;self.directory=Path(policy['directory'])
        self.deadline=time.monotonic()+WORK_SECONDS;self.stage='PREFLIGHT'
    def effect_window(self):
        need(time.time()<self.p['expiresAtEpoch'] and time.monotonic()<self.deadline,'POLICY_EXPIRED')
    def execute(self):
        try:return self._execute()
        except BaseException:
            if os.path.lexists(self.directory/'ATTEMPT.json'):
                try:exclusive(self.directory/'FAILURE.json',{'state':'MAINTENANCE_UNCONFIRMED','stage':self.stage,
                              'retryAllowed':False,'helperOperationRetained':True})
                except BaseException:pass # Preserve the original uncertainty; watchdog remains independent.
            raise
    def _execute(self):
        with directory_lock(self.directory):
            need(not os.path.lexists(self.directory/'ATTEMPT.json'),'CONTROLLER_ALREADY_CONSUMED')
            need(all(p.name=='operation.lock'for p in self.directory.iterdir()),'FRESH_CONTROLLER_DIRECTORY_REQUIRED')
            need(not any(Path(self.p['operation']).iterdir()),'FRESH_HELPER_OPERATION_REQUIRED')
            baseline=self.io.snapshot();site=self.io.inspect();need(site['State']['Paused']is False,'WEBSITE_ALREADY_PAUSED')
            fingerprint=website_fingerprint(site)
            self.effect_window()
            exclusive(self.directory/'ATTEMPT.json',{'version':1,'kind':'BOUNDED_SAME_CID_WEBSITE_QUIESCENCE',
                      'websiteId':self.p['website']['id'],'baselineSHA256':digest(encoded(baseline)),
                      'workSeconds':WORK_SECONDS,'recoverySeconds':RECOVERY_SECONDS})
            ok=False;armed=False;result=None
            try:
                self.stage='ARM';self.effect_window();self.io.arm();armed=True
                self.stage='PAUSE';self.effect_window();self.io.pause();item=self.io.inspect()
                need(item['State']['Paused']is True and website_fingerprint(item)==fingerprint,'PAUSE_READBACK_CHANGED')
                need(self.io.snapshot()==baseline,'FULL_BASELINE_CHANGED_AFTER_PAUSE')
                self.stage='PREPARE';self.effect_window();response=self.io.helper('prepare');plan=self.io.prepared();sha=response.get('planSHA256')
                need(response.get('effects')is False and response.get('configUnchanged')is True,'PREPARE_REPLY')
                current=self.io.snapshot();need(current==baseline,'FULL_BASELINE_CHANGED_AFTER_PREPARE')
                self.stage='PLAN_REVIEW';validate_plan(plan,self.p,current,sha)
                self.effect_window()
                exclusive(self.directory/'REVIEW-SUMMARY.json',{'planSHA256':sha,'generationSHA256':digest(encoded(plan['generation'])),
                          'protectedSHA256':digest(encoded(plan['protected'])),'nativeSHA256':digest(encoded(plan['native'])),
                          'wholeCompanyIncluded':True,'closedWhitelistPassed':True})
                item=self.io.inspect();need(item['State']['Paused']is True and website_fingerprint(item)==fingerprint,'WEBSITE_NOT_FROZEN')
                self.stage='APPLY';self.effect_window();result=self.io.helper('apply',sha)
                need(result.get('state')=='TRANSPORT_REPLACED' and result.get('configUnchanged')is True and
                     result.get('workerEffects')is False and result.get('noWakeCommand')is True,'APPLY_REPLY_UNCONFIRMED')
                ok=True
            finally:
                try:
                    need(self.io.helper_settled(),'HELPER_GROUP_UNSETTLED')
                    self.io.unpause()
                    need(website_fingerprint(self.io.inspect())==fingerprint,'WEBSITE_CONFIG_CHANGED')
                    if armed:self.io.cancel()
                except BaseException:
                    self.io.abandon();raise
            need(ok,'TRANSPORT_OUTCOME_UNCONFIRMED')
            self.stage='COMPLETION';self.effect_window()
            exclusive(self.directory/'DONE.next.json',{'state':'TRANSPORT_REPLACED_WEBSITE_UNPAUSED','websiteId':self.p['website']['id'],
                      'configUnchanged':True,'providerRestartCommand':False,'watchdogSettled':True})
            done_stamp=stamp(self.directory/'DONE.next.json')
        # Finish the operation descriptor finalizer before publishing completion.
        # A crash may lose this last rename; it cannot manufacture completion.
        item=self.io.inspect()
        need(item['State']['Paused']is False and website_fingerprint(item)==fingerprint,'FINAL_WEBSITE_CHANGED')
        need(stamp(self.directory/'DONE.next.json')==done_stamp,'COMPLETION_RECEIPT_CHANGED')
        self.effect_window()
        os.rename(self.directory/'DONE.next.json',self.directory/'DONE.json')
        return result


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--policy',required=True,type=Path);parser.add_argument('--policy-sha256',required=True)
    parser.add_argument('--execute',action='store_true');parser.add_argument('--watchdog-fd',type=int);args=parser.parse_args(argv)
    os.umask(0o077)
    need(sys.platform=='linux' and os.getuid()==os.geteuid()!=0,'ORDINARY_LINUX_OWNER_REQUIRED')
    policy=policy_file(args.policy,args.policy_sha256,recovery=args.watchdog_fd is not None)
    if args.watchdog_fd is not None:
        need(not args.execute and args.watchdog_fd>=3,'WATCHDOG_DESCRIPTOR');watchdog(policy,args.watchdog_fd);return 0
    need(args.execute,'EXPLICIT_EXECUTION_REQUIRED')
    def interrupted(*_):raise RuntimeError('CONTROLLER_INTERRUPTED')
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(sig,interrupted)
    result=Controller(policy,Ports(policy,args.policy,args.policy_sha256)).execute()
    print(json.dumps({'state':result['state'],'websiteUnpaused':True,'configUnchanged':True}));return 0

if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:
        print('Coordinated maintenance refused/unconfirmed; retain attempt and inspect fixed recovery receipts. No retry or rollback.',file=sys.stderr);raise SystemExit(1)
