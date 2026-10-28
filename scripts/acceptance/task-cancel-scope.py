"""Fixed outside-scope lease owner for one isolated task-cancel component run.

Source/import is inert. No general command, cleanup callback or native authority
port is exposed. Root separately admits one fixed own fixture. Failed/unknown
attempts are retained; a deadline or process exit is never a zero-survivor proof.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from decimal import Decimal

HERE=Path(__file__).resolve().parent
RUNTIME=120
STOP=30
TOTAL=180
MEMORY=536870912
TASKS=128
NATIVE_FILES={'task-cancel-native.py','task-cancel-authority.mjs','task-cancel-program.py'}
OUTER_FILES={'task-cancel-scope.py','task-cancel-scope.test.py','task-cancel-source.test.py'}
LEASE_FILES={'python/reverie/__init__.py','python/reverie/workspaces.py','python/reverie/lease.py','python/reverie/cleanup/lease.py'}

def need(value,message):
    if not value:raise RuntimeError(message)
def digest(raw):return hashlib.sha256(raw).hexdigest()
def read_private(path,limit=1048576):
    path=Path(path);need(path.is_absolute()and path.resolve()==path,'canonical private metadata required')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode)and before.st_uid==os.getuid()and before.st_nlink==1 and stat.S_IMODE(before.st_mode)==0o600 and before.st_size<=limit,'bounded own0600 metadata required')
        raw=bytearray()
        while len(raw)<=limit:
            part=os.read(fd,min(65536,limit+1-len(raw)))
            if not part:break
            raw.extend(part)
        stamp=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        need(len(raw)==before.st_size and stamp(before)==stamp(os.fstat(fd))==stamp(path.lstat()),'private metadata changed')
        return bytes(raw)
    finally:os.close(fd)
def exclusive(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    with os.fdopen(fd,'w')as out:
        json.dump(value,out,indent=2);out.write('\n');out.flush();os.fsync(out.fileno())
    directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:os.fsync(directory)
    finally:os.close(directory)
def remaining(deadline,maximum):
    value=min(maximum,deadline-time.monotonic());need(value>0,'absolute outer deadline exhausted');return value
def bus_environment(tools):
    env={key:os.environ[key]for key in('HOME','USER','LOGNAME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG')if key in os.environ}
    env['PATH']=':'.join(dict.fromkeys(str(Path(p).parent)for p in tools.values()));return env
def process(pid):
    try:
        row=Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()
        return {'pid':pid,'startTick':row[19]}
    except FileNotFoundError:return None
def live(value):
    current=process(value['pid']);return current is not None and current['startTick']==value['startTick']
def time_value(text):
    need(type(text)is str and 0<len(text)<=64,'finite scope time required')
    tokens=re.findall(r'([0-9]+(?:\.[0-9]+)?)(us|ms|s|min|h)',text)
    need(tokens and ''.join(a+b for a,b in tokens)==''.join(text.split()),'unsupported scope time')
    scale={'us':Decimal('.000001'),'ms':Decimal('.001'),'s':Decimal(1),'min':Decimal(60),'h':Decimal(3600)}
    return sum(Decimal(n)*scale[unit]for n,unit in tokens)
def query(tools,unit,deadline):
    response=subprocess.run([tools['systemctl'],'--user','show',unit,'--property=Id,InvocationID,LoadState,ActiveState,SubState,Result,ControlGroup,RuntimeMaxUSec,TimeoutStopUSec,MemoryMax,MemorySwapMax,TasksMax'],env=bus_environment(tools),capture_output=True,text=True,timeout=remaining(deadline,3))
    need(len(response.stdout)<=16384,'scope metadata bound')
    result={}
    for line in response.stdout.splitlines():
        key,separator,value=line.partition('=');need(separator and key not in result,'invalid scope properties');result[key]=value
    return response.returncode,result
def capture_scope(value,unit):
    need(re.fullmatch(r'reverie-task-cancel-[a-f0-9]{32}\.scope',unit)and value.get('Id')==unit,'wrong own scope')
    need(value.get('ActiveState')=='active'and re.fullmatch('[a-f0-9]{32}',value.get('InvocationID','')),'actual active scope missing')
    group=value.get('ControlGroup','');need(group.startswith('/')and Path(group).name==unit and '..'not in Path(group).parts,'wrong actual cgroup')
    need(time_value(value.get('RuntimeMaxUSec'))==RUNTIME and time_value(value.get('TimeoutStopUSec'))==STOP,'independent scope lifetime differs')
    need(value.get('MemoryMax')==str(MEMORY)and value.get('MemorySwapMax')=='0'and value.get('TasksMax')==str(TASKS),'scope resource limits differ')
    return {'unit':unit,'invocationId':value['InvocationID'],'controlGroup':group}
def same_scope(value,binding):
    return value.get('Id')==binding['unit']and value.get('InvocationID')==binding['invocationId']and value.get('ControlGroup')in(binding['controlGroup'],'')
def terminal_scope(value,binding):
    unloaded=value.get('LoadState')=='not-found'and not value.get('InvocationID')and not value.get('ControlGroup')
    return value.get('Id')==binding['unit']and value.get('ActiveState')in('inactive','failed')and(same_scope(value,binding)or unloaded)
def cgroup_empty(group):
    root=Path('/sys/fs/cgroup')/group.lstrip('/')
    try:return dict(line.split()for line in(root/'cgroup.events').read_text().splitlines()).get('populated')=='0'
    except FileNotFoundError:return not root.exists()
def inner_observation(task,pins_sha):
    path=task/'TASK-CANCEL-ATTEMPT.json'
    if not path.exists():return {'root':None,'result':None,'survivors':[],'known':[]}
    attempt=json.loads(read_private(path));need(attempt.get('pinsSHA256')==pins_sha,'inner attempt pin differs')
    root=Path(attempt['root']);need(root.parent==task and re.fullmatch('cancel-fixture-[a-f0-9]{32}',root.name)and root.resolve()==root,'inner fixture root differs')
    item=root.lstat();need(stat.S_ISDIR(item.st_mode)and item.st_uid==os.getuid()and stat.S_IMODE(item.st_mode)==0o700,'inner fixture root custody differs')
    records=[]
    if(root/'AUTHORITY-PID.json').exists():records.append(json.loads(read_private(root/'AUTHORITY-PID.json',4096)))
    directory=root/'tasks/heartbeat'
    if directory.exists():
        for count,path in enumerate(directory.iterdir(),1):
            need(count<=128,'fixture record bound')
            if re.fullmatch(r'(runner|heartbeat)-[0-9]+\.json',path.name):records.append(json.loads(read_private(path,4096)))
    for value in records:need(type(value.get('pid'))is int and value['pid']>1 and type(value.get('startTick'))is str,'invalid captured process')
    result_path=root/'RESULT.json';result=None;result_sha=None
    if result_path.exists():
        raw=read_private(result_path);result=json.loads(raw);result_sha=digest(raw)
    return {'root':str(root),'result':result,'resultSHA256':result_sha,'survivors':[r for r in records if live(r)],'known':[{'pid':r['pid'],'startTick':r['startTick']}for r in records]}
def held_operation_fd(path):
    expected=path.lstat();need(stat.S_ISREG(expected.st_mode)and expected.st_uid==os.getuid()and expected.st_nlink==1,'own canonical operation inode required')
    matches=[]
    for count,entry in enumerate(Path('/proc/self/fd').iterdir(),1):
        need(count<=256,'controller descriptor bound')
        try:
            fd=int(entry.name);info=os.fstat(fd)
            if(info.st_dev,info.st_ino)==(expected.st_dev,expected.st_ino):matches.append(fd)
        except (FileNotFoundError,OSError):continue
    need(len(matches)==1,'canonical held operation descriptor ambiguous')
    fd=matches[0];os.fchmod(fd,0o600)
    need(stat.S_IMODE(os.fstat(fd).st_mode)==0o600,'private operation descriptor required');return fd
def verify_sources(pins):
    need(set(pins['scripts'])==NATIVE_FILES and set(pins['outerScripts'])==OUTER_FILES,'closed six-file source required')
    for name,sha in {**pins['scripts'],**pins['outerScripts']}.items():need(digest((HERE/name).read_bytes())==sha,'reviewed source differs')
def immutable_bytes(path,expected,limit):
    resolved=path.resolve(strict=True);item=resolved.stat()
    need(resolved.is_relative_to('/nix/store')and stat.S_ISREG(item.st_mode)and item.st_uid==0 and not item.st_mode&0o222 and item.st_size<=limit,'immutable bounded closure file required')
    need(digest(resolved.read_bytes())==expected,'immutable closure file bytes differ')
def cpu_set(value):
    need(type(value)is list and 1<=len(value)<=8 and all(type(n)is int and n>=0 for n in value)and len(set(value))==len(value),
         'private finite unique CPU list required')
    return value
def validate(args):
    source_only=getattr(args,'check_source',False)
    need(bool(args.run_owned_fixture)!=bool(source_only),'choose explicit source check or root native admission')
    need(re.fullmatch('[a-f0-9]{64}',args.pins_sha256),'reviewed raw pin digest required')
    raw=read_private(Path(args.pins).resolve(strict=True),262144);need(digest(raw)==args.pins_sha256,'private pins changed');pins=json.loads(raw)
    if not source_only:need(re.fullmatch('[a-f0-9]{32}',pins.get('operationId')or''),'fresh reviewed operation ID required; pending inputs refuse')
    verify_sources(pins);tools=pins['tools']
    need(set(tools)=={'python','node','systemctl','flock','systemd-run','taskset'}and set(pins['toolSHA256'])==set(tools),'fixed immutable tool closure required')
    for name,value in tools.items():
        path=Path(value);item=path.stat()
        need(path.is_relative_to('/nix/store')and path.resolve()==path and stat.S_ISREG(item.st_mode)and item.st_uid==0 and not item.st_mode&0o222 and item.st_mode&0o111,'immutable tool custody differs')
        immutable_bytes(path,pins['toolSHA256'][name],268435456)
    for kind,base in(('consumerModules',Path(pins['hands'])),('consoleModules',Path(pins['console'])/'lib/reverie/dist')):
        need(base.is_relative_to('/nix/store')and base.resolve()==base and 0<len(pins[kind])<=64,'fixed immutable component closure required')
        for name,sha in pins[kind].items():
            need(type(name)is str and re.fullmatch(r'[A-Za-z0-9_./-]+\.'+('py'if kind=='consumerModules'else'js'),name)and '..'not in Path(name).parts and not Path(name).is_absolute()and(kind!='consumerModules'or'/'not in name),'component module path differs')
            immutable_bytes(base/name,sha,8388608)
    need(Path(sys.executable).resolve()==Path(tools['python']),'use the pinned controller Python')
    with Path('/proc/self/cmdline').open('rb')as stream:command=stream.read(16385)
    need(len(command)<=16384 and command.split(b'\0')[:4]==[tools['python'].encode(),b'-I',b'-B',str(HERE/'task-cancel-scope.py').encode()],
         'invoke exact pinned Python -I -B and PHYSICAL controller script path')
    source=HERE.parents[1];need(set(pins['leaseFiles'])==LEASE_FILES and 'REVERIE_LEASE_LIB'not in os.environ,'canonical lease closure required')
    for name,sha in pins['leaseFiles'].items():need(digest((source/name).read_bytes())==sha,'canonical lease source differs')
    task=Path(args.lease_root).resolve(strict=True);item=task.lstat();need(item.st_uid==os.getuid()and stat.S_ISDIR(item.st_mode)and stat.S_IMODE(item.st_mode)==0o700,'private task required')
    need(os.sched_getaffinity(0)<=set(cpu_set(pins.get('cpuSet'))),'controller CPU binding differs from private pins')
    return pins,tools,task,source
@contextmanager
def requested_stop():
    state={'signal':None}
    def mark(number,_):state['signal']=number
    before={sig:signal.signal(sig,mark)for sig in(signal.SIGTERM,signal.SIGINT,signal.SIGHUP)}
    try:yield state
    finally:
        for sig,handler in before.items():signal.signal(sig,handler)
def settle_client(child,binding,pidfd,deadline):
    if child is None:return {'known':False,'reason':'NO_CHILD_IDENTITY'}
    signaled=False
    if child.poll()is None:
        need(binding is not None and pidfd is not None and live(binding),'scope client identity lost; no guessed signal')
        signal.pidfd_send_signal(pidfd,signal.SIGTERM);signaled=True
        try:child.wait(timeout=remaining(deadline,3))
        except subprocess.TimeoutExpired:
            signal.pidfd_send_signal(pidfd,signal.SIGKILL);child.wait(timeout=remaining(deadline,2))
    need(binding is not None and not live(binding),'scope client remains')
    try:os.killpg(child.pid,0)
    except ProcessLookupError:return {'known':True,'signaled':signaled}
    raise RuntimeError('scope client process group remains')
def stop_owned_scope(tools,unit,binding,deadline):
    _,fresh=query(tools,unit,deadline);need(same_scope(fresh,binding),'unit changed before owned stop')
    subprocess.run([tools['systemctl'],'--user','stop',unit],env=bus_environment(tools),capture_output=True,timeout=remaining(deadline,STOP+3),check=True)
def observe(task,pins_sha,tools,unit,child,stop,deadline):
    binding=None;last={};failure=[];settled=False;forced=False;inner={'result':None,'known':[],'survivors':[]};exited_at=None
    while time.monotonic()<deadline:
        try:
            log=task/'SCOPE-CLIENT.log'
            if log.exists()and log.stat().st_size>1048576 and not any(e['class']=='OutputBoundExceeded'for e in failure):
                failure.append({'class':'OutputBoundExceeded','message':'fixed own fixture output bound exceeded'})
            code,last=query(tools,unit,deadline)
            if binding is None and code==0 and last.get('ActiveState')=='active':
                binding=capture_scope(last,unit);exclusive(task/'ACTUAL-SCOPE.json',binding)
            inner=inner_observation(task,pins_sha)
            if binding is not None:
                if terminal_scope(last,binding)and cgroup_empty(binding['controlGroup'])and not inner['survivors']:
                    settled=True;break
                need(same_scope(last,binding),'actual unit rebound; no guessed stop')
                if child.poll()is not None and exited_at is None:exited_at=time.monotonic()
                unexpected_exit=exited_at is not None and time.monotonic()-exited_at>=3 and not cgroup_empty(binding['controlGroup'])
                if not forced and(stop['signal']is not None or failure or unexpected_exit):
                    forced=True
                    stop_owned_scope(tools,unit,binding,deadline)
        except BaseException as error:
            if len(failure)<8:failure.append({'class':type(error).__name__,'message':str(error)[:240]})
            if binding is not None and not forced:
                # Even a malformed/missing inner receipt must not suppress fixed
                # cleanup of an independently captured own unit. Fresh identity
                # is mandatory; rebound units are never stopped.
                forced=True
                try:stop_owned_scope(tools,unit,binding,deadline)
                except BaseException as cleanup:
                    if len(failure)<8:failure.append({'class':type(cleanup).__name__,'message':str(cleanup)[:240]})
        value=deadline-time.monotonic()
        if value>0:time.sleep(min(.1,value))
    if not settled:failure.append({'class':'ScopeSettlementUnknown','message':'deadline does not establish zero survivors'})
    return {'binding':binding,'properties':last,'settled':settled,'forcedStop':forced,'failures':failure,'inner':inner}
def accepted(observation,client_cleanup,returncode,errors,signal_number):
    result=observation['inner'].get('result')
    return (observation['settled']and client_cleanup['known']and not client_cleanup.get('signaled')and
        not errors and not observation['failures']and not observation['forcedStop']and signal_number is None and
        returncode==0 and not observation['inner'].get('survivors')and result is not None and
        result.get('state')=='PASS_OWN_CANONICAL_CANCEL_COMPONENT')
def main():
    parser=argparse.ArgumentParser(description=__doc__);action=parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--run-owned-fixture',action='store_true');action.add_argument('--check-source',action='store_true')
    for name in('lease-root','pins','pins-sha256'):parser.add_argument('--'+name,required=True)
    args=parser.parse_args();pins,tools,task,source=validate(args);os.umask(0o077)
    if args.check_source:
        print(json.dumps({'state':'SOURCE_METADATA_PASS_NATIVE_NOT_RUN','sourceFiles':6,'tools':6,'consumerModules':len(pins['consumerModules']),'consoleModules':len(pins['consoleModules']),'leaseFiles':4,'pendingOperation':pins.get('operationId')is None}));return
    sys.path.insert(0,str(source/'python'));from reverie.workspaces import Workspaces
    manager=Workspaces(task.parent);unit='reverie-task-cancel-'+pins['operationId']+'.scope'
    with manager.operation(task.name),manager.lease.hold([str(task)],argv0='fixed-task-cancel-outside-controller'):
        metadata=json.loads(read_private(task/'.reverie-task.json'))
        need(metadata.get('id')==task.name and metadata.get('status')=='allocated','fresh allocated task required')
        need(not any(os.path.lexists(task/name)for name in('SCOPE-ATTEMPT.json','TASK-CANCEL-ATTEMPT.json','SCOPE-RESULT.json')),'consumed or unknown attempt; no replay')
        opfd=held_operation_fd(task.parent/'.ops'/(task.name+'.lock'));manager._reserve(task,renew=True)
        attempt={'kind':'OWNED_TASK_CANCEL_SCOPE','operationId':pins['operationId'],'unit':unit,'pinsSHA256':args.pins_sha256,
            'outerPID':process(os.getpid()),'controller':{'exe':tools['python'],'entry':str(HERE/'task-cancel-scope.py'),
            'entrySHA256':pins['outerScripts']['task-cancel-scope.py'],'operationLockFD':opfd},'at':time.time()}
        exclusive(task/'SCOPE-ATTEMPT.json',attempt);attempt_sha=digest(read_private(task/'SCOPE-ATTEMPT.json'))
        manager.write(task,{**metadata,'status':'running','scopeUnit':unit,'scopeAttemptSHA256':attempt_sha})
        deadline=time.monotonic()+TOTAL;monitor_deadline=deadline-8;child=None;child_binding=None;pidfd=None;observation=None;errors=[];client_cleanup={'known':False}
        command=[tools['systemd-run'],'--user','--scope','--unit',unit,'--property=RuntimeMaxSec='+str(RUNTIME),'--property=TimeoutStopSec='+str(STOP),
            '--property=MemoryMax='+str(MEMORY),'--property=MemorySwapMax=0','--property=TasksMax='+str(TASKS),tools['taskset'],'-c',','.join(map(str,cpu_set(pins['cpuSet']))),
            tools['python'],'-I','-B',str(HERE/'task-cancel-native.py'),'--run-owned-fixture','--lease-root',str(task),'--pins',str(Path(args.pins).resolve()),
            '--pins-sha256',args.pins_sha256,'--outer-attempt-sha256',attempt_sha]
        env=bus_environment(tools)
        with requested_stop()as stop:
            try:
                with(task/'SCOPE-CLIENT.log').open('xb')as log:
                    child=subprocess.Popen(command,cwd=source,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                    child_binding=process(child.pid);need(child_binding is not None,'scope client PID unavailable');pidfd=os.pidfd_open(child.pid)
                    exclusive(task/'SCOPE-CLIENT-PID.json',child_binding)
                    observation=observe(task,args.pins_sha256,tools,unit,child,stop,monitor_deadline)
            except BaseException as error:errors.append({'class':type(error).__name__,'message':str(error)[:240]})
            finally:
                if child is not None:
                    if observation is None:observation=observe(task,args.pins_sha256,tools,unit,child,stop,monitor_deadline)
                    try:client_cleanup=settle_client(child,child_binding,pidfd,deadline)
                    except BaseException as error:errors.append({'class':type(error).__name__,'message':str(error)[:240]})
                if pidfd is not None:os.close(pidfd)
        if observation is None:observation={'settled':False,'failures':[],'forcedStop':False,'inner':{'result':None}}
        # A durable inner RESULT is necessary. A local Python PASS variable,
        # output TTL, killed scope, lost receipt or deadline cannot satisfy it.
        result=observation['inner'].get('result');settled=observation['settled']and client_cleanup['known']
        try:
            verify_sources(pins)
            need(digest(read_private(Path(args.pins).resolve()))==args.pins_sha256,'private input changed after launch')
            final_inner=inner_observation(task,args.pins_sha256)
            need(final_inner.get('resultSHA256')==observation['inner'].get('resultSHA256')and not final_inner['survivors'],'durable result/process changed after observation')
        except BaseException as error:errors.append({'class':type(error).__name__,'message':str(error)[:240]})
        passed=accepted(observation,client_cleanup,None if child is None else child.returncode,errors,stop['signal'])
        value={'state':'PASS_OWN_CANONICAL_CANCEL_COMPONENT'if passed else('FAIL_SCOPE_SETTLED'if settled else'UNKNOWN_NO_REPLAY'),
            'scope':observation,'client':child_binding,'clientCleanup':client_cleanup,'returncode':None if child is None else child.returncode,
            'errors':errors,'signal':stop['signal'],'nativeAgentAuthentication':'NOT_EXERCISED','productionEffects':False,'at':time.time()}
        exclusive(task/'SCOPE-RESULT.json',value)
        manager.write(task,{**metadata,'status':'awaiting_handoff'if settled else'cleanup_unknown','scopeUnit':unit,'scopeAttemptSHA256':attempt_sha,'result':value['state']})
        manager._reserve(task,renew=True)
        need(passed,'task-cancel fixture failed/unknown; preserve one-shot attempt; no replay')
if __name__=='__main__':main()
