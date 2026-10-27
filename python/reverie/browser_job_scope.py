"""Fixed broker-thread supervisor OUTSIDE the own GPU scope. Import is inert.

The actual OfficeAPI actor/common gate supplies the private handle; there is no
CLI accepting a JSON owner, arbitrary command, callback, engine action or PID.
"""
import hashlib,json,os,re,selectors,signal,stat,subprocess,sys,time
from pathlib import Path
from .browser_job_requests import need,private_bytes,exclusive,digest,BrowserJobRefused
from .host_job_scope import OwnScopeObserver,ScopeUnknown,_query,_birth,_sha
from .workspaces import Workspaces


def remaining(deadline,maximum):
    value=min(maximum,deadline-time.monotonic());need(value>0,'ABSOLUTE_JOB_DEADLINE');return value

def own_environment(policy,root):
    # systemd-run needs the actual user bus. Node clears those bus-only entries
    # before any browser/tool launch. No credential/config/CLI env is inherited.
    env={k:os.environ[k]for k in('USER','LOGNAME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS')if k in os.environ}
    env.update(HOME=str(root/'home'),PATH=':'.join(dict.fromkeys(str(Path(v['path']).parent)for v in policy['tools'].values())),LANG='C.UTF-8',TMPDIR=str(root/'tmp'),XDG_CACHE_HOME=str(root/'cache'),XDG_CONFIG_HOME=str(root/'config'))
    return env

def output_inventory(root,maximum):
    count=0;size=0
    for current,dirs,files in os.walk(root,followlinks=False):
        for name in [*dirs,*files]:
            count+=1;need(count<=8192,'OWN_JOB_FILE_COUNT');p=Path(current)/name;s=p.lstat();size+=s.st_size if stat.S_ISREG(s.st_mode)or stat.S_ISLNK(s.st_mode)else 0;need(size<=maximum,'OWN_JOB_OUTPUT_BOUND')
    return {'entries':count,'bytes':size}

def operation_fd(task):
    expected=(task.parent/'.ops'/(task.name+'.lock')).stat();found=[]
    for count,p in enumerate(Path('/proc/self/fd').iterdir(),1):
        need(count<=4096,'OWN_DESCRIPTOR_BOUND')
        try:
            n=int(p.name);s=os.fstat(n)
            if(s.st_dev,s.st_ino)==(expected.st_dev,expected.st_ino):found.append(n)
        except (OSError,ValueError):continue
    need(len(found)==1,'ACTUAL_RETAINED_OPERATION_FD');os.fchmod(found[0],0o600);return found[0]

def lifecycle(manager,task,metadata):
    manager.write(task,metadata)
    fd=os.open(task/'.reverie-task.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:os.fchmod(fd,0o600);os.fsync(fd)
    finally:os.close(fd)

def stop_owned(policy,binding,deadline):
    spec=binding.spec;_,p=_query(spec,deadline)
    need(p.get('InvocationID')==binding.invocation_id and p.get('ControlGroup')in(binding.control_group,''),'NO_STOP_REBOUND_SCOPE')
    subprocess.run([spec.systemctl,'--user','stop',spec.unit],env={k:os.environ[k]for k in('HOME','USER','LOGNAME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG')if k in os.environ},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=remaining(deadline,spec.stop_seconds+3),check=True)

def broker_controller(task,policy):
    module=Path(__file__).resolve(strict=True).with_name('worker.py');need(module.is_relative_to('/nix/store')and _sha(module)==policy['pythonSource']['worker.py'],'INSTALLED_BROKER_SOURCE_REQUIRED')
    proc=_birth(os.getpid());need(proc is not None,'ACTUAL_BROKER_PID')
    return {'pid':os.getpid(),'startTick':proc[0].start_tick,'exe':str(Path('/proc/self/exe').resolve(strict=True)),'workerModule':str(module),'operationLockFD':operation_fd(task)}

def reap_client(child,pidfd,deadline,errors):
    """Only the retained direct child descriptor; every wait shares one deadline."""
    if child is None:return
    try:
        try:child.stdin.close()
        except OSError:pass
        if child.poll()is None:
            need(pidfd is not None,'DIRECT_CLIENT_PIDFD_UNKNOWN')
            signal.pidfd_send_signal(pidfd,signal.SIGTERM)
            try:child.wait(timeout=remaining(deadline,3))
            except subprocess.TimeoutExpired:
                signal.pidfd_send_signal(pidfd,signal.SIGKILL);child.wait(timeout=remaining(deadline,2))
    except BaseException as error:errors.append({'class':type(error).__name__,'stage':'client-cleanup'})
    finally:
        try:child.stdout.close()
        except OSError:pass
        if pidfd is not None:os.close(pidfd)

def supervise(service,task,record,spec,claim):
    """The sole fixed producer invoked by BrowserJobRequests; never caller-selected."""
    policy=service.policy;broker=service.broker;root=task/'f';child=None;pidfd=None;client_birth=None;binding=None;settlement=None;errors=[];forced=False;node_result=None;sequence=0;deadline=time.monotonic()+policy['limits']['outerSeconds'];monitor=deadline-8
    # No signal handlers are changed by this broker thread. Broker draining and
    # protected cancellation are observed; the independent scope timer remains.
    try:
        manager=Workspaces(task.parent);observer=OwnScopeObserver()
        with manager.operation(task.name),manager.lease.hold([str(task)],argv0='fixed-public-gpu-job'):
            original=json.loads(private_bytes(task/'.reverie-task.json'));need(original.get('status')=='allocated','ONE_SHOT_ALLOCATED_TASK')
            need(not any((task/n).exists()for n in('SCOPE-ATTEMPT.json','NODE-INPUT.json','SCOPE-RESULT.json')),'JOB_ATTEMPT_CONSUMED')
            service.authority(record['actor']['sessionId'],record['requestMessageId'],record['authority'],deadline=monitor)
            controller=broker_controller(task,policy)
            node_input={**record,'controller':controller};exclusive(task/'NODE-INPUT.json',node_input)
            exclusive(task/'SCOPE-ATTEMPT.json',{'kind':'FIXED_PUBLIC_GPU_SCOPE_ATTEMPT','operationId':record['operationId'],'policySHA256':service.policy_sha,'jobInputSHA256':hashlib.sha256(private_bytes(task/'JOB-INPUT.json')).hexdigest(),'at':time.time()})
            lifecycle(manager,task,{**original,'status':'running','operationId':record['operationId'],'scopeUnit':spec.unit})
            t=policy['tools'];command=[t['systemdRun']['path'],'--user','--scope','--quiet','--unit',spec.unit,'--property=RuntimeMaxSec='+str(spec.runtime_seconds),'--property=TimeoutStopSec='+str(spec.stop_seconds),'--property=MemoryMax='+str(spec.memory_bytes),'--property=MemorySwapMax=0','--property=TasksMax='+str(spec.pids),t['taskset']['path'],'-c',','.join(map(str,spec.cpus)),spec.node_exe,spec.node_entry,'--input',str(task/'NODE-INPUT.json'),'--policy',str(service.path)]
            stderr=None;selector=None;buffer=bytearray();last_output=0
            try:
                stderr=(task/'SCOPE-STDERR.log').open('xb');selector=selectors.DefaultSelector()
                child=subprocess.Popen(command,cwd=spec.working_directory,env=own_environment(policy,root),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,start_new_session=True,close_fds=True,bufsize=0,umask=0o077)
                found=_birth(child.pid);need(found is not None,'ACTUAL_SCOPE_CLIENT_PID');client_birth=found[0];pidfd=os.pidfd_open(child.pid);exclusive(task/'SCOPE-CLIENT-PID.json',{'pid':client_birth.pid,'startTick':client_birth.start_tick});selector.register(child.stdout,selectors.EVENT_READ)
                while time.monotonic()<monitor:
                    need(not broker.stopping.is_set()and not broker.draining.is_set(),'BROKER_STOP_OR_DRAIN')
                    need(not(task/'CANCEL.json').exists(),'OWN_JOB_CANCEL_REQUESTED')
                    if time.monotonic()-last_output>=1:output_inventory(task,policy['limits']['outputBytes']);last_output=time.monotonic()
                    if child.poll()is not None:break
                    for key,_ in selector.select(remaining(monitor,.1)):
                        raw=os.read(key.fd,4096)
                        if not raw:selector.unregister(key.fileobj);continue
                        buffer.extend(raw);need(len(buffer)<=8192,'FIXED_GUARD_FRAME_BOUND')
                        while b'\n'in buffer:
                            row,_,tail=buffer.partition(b'\n');buffer=bytearray(tail);need(len(row)<=4096,'FIXED_GUARD_FRAME_BOUND');message=json.loads(row)
                            need(set(message)=={'kind','sequence','policySHA256'}and message['kind']=='FIXED_JOB_GUARD'and type(message['sequence'])is int and message['sequence']==sequence+1 and message['sequence']<=10000 and message['policySHA256']==service.policy_sha,'FIXED_GUARD_PROTOCOL');sequence=message['sequence']
                            if binding is None:
                                binding=observer.capture(spec,deadline=monitor);observer.attach_client(binding,child);broker.resource_reservations.bind_host_job(claim,binding,deadline=monitor);exclusive(task/'ACTUAL-SCOPE.json',binding.metadata())
                            else:observer.observe_processes(binding,deadline=monitor)
                            service.authority(record['actor']['sessionId'],record['requestMessageId'],record['authority'],deadline=monitor);need(time.monotonic()<monitor,'ABSOLUTE_JOB_DEADLINE');need(not(task/'CANCEL.json').exists(),'OWN_JOB_CANCEL_REQUESTED')
                            child.stdin.write(json.dumps({'sequence':sequence,'policySHA256':service.policy_sha,'allowed':True}).encode()+b'\n');child.stdin.flush()
                need(child.poll()is not None,'JOB_OBSERVATION_DEADLINE')
            except BaseException as error:
                errors.append({'class':type(error).__name__,'messageSHA256':hashlib.sha256(str(error).encode()).hexdigest()});forced=True
                if binding is not None:
                    try:stop_owned(policy,binding,monitor)
                    except BaseException as e:errors.append({'class':type(e).__name__,'stage':'owned-stop'})
            finally:
                # A stream finalizer failure cannot skip direct-child cleanup.
                try:
                    if selector is not None:selector.close()
                    if stderr is not None:stderr.close()
                finally:reap_client(child,pidfd,deadline,errors);pidfd=None
            if binding is not None:
                while time.monotonic()<deadline:
                    try:settlement=observer.verify_settled(binding,deadline=deadline);break
                    except ScopeUnknown:time.sleep(min(.1,remaining(deadline,.1)))
            need(settlement is not None,'ACTUAL_SCOPE_SETTLEMENT_UNKNOWN')
            output=output_inventory(task,policy['limits']['outputBytes']);result_path=root/'NODE-RESULT.json'
            if result_path.exists():node_result=json.loads(private_bytes(result_path))
            success=not errors and not forced and child is not None and child.returncode==0 and node_result is not None and node_result.get('state')=='CAPTURE_COMPLETED_NOT_RELEASE_ACCEPTANCE'
            delivery=None
            if success:
                try:delivery=service.deliver(task,record,deadline)
                except BaseException as error:
                    delivery={'state':'DELIVERY_UNKNOWN_NO_RETRY','class':type(error).__name__,'messageSHA256':hashlib.sha256(str(error).encode()).hexdigest()};exclusive(task/'DELIVERY-UNKNOWN.json',delivery)
            value={'state':'CAPTURE_COMPLETED_SCOPE_SETTLED'if success else'FAILED_SCOPE_SETTLED','nativeSettlement':settlement.metadata(),'nodeResult':node_result,'errors':errors,'forcedStop':forced,'output':output,'delivery':delivery,'resourceRelease':'PENDING_COMMON_GATE_VERIFICATION','scientificInterpretation':'REQUESTER_REQUIRED','at':time.time()};exclusive(task/'SCOPE-RESULT.json',value)
            lifecycle(manager,task,{**original,'status':'awaiting_handoff','scopeUnit':spec.unit,'result':value['state']});manager._reserve(task,renew=True)
        # All own stream/PIDFD/lease/operation cleanup precedes release. Common
        # gate independently reobserves the actual registered scope under its
        # admission lock; no caller JSON or local PASS variable can clear it.
        broker.resource_reservations.finish_host_job(claim,binding,deadline=deadline)
        service.jobs[record['operationId']]=(claim,spec,('CAPTURE_COMPLETED_ARTIFACTS_DELIVERED'if delivery is not None and delivery.get('kind')=='CAPTURE_ARTIFACTS_DELIVERED'else'CAPTURE_COMPLETED_DELIVERY_UNKNOWN_NO_RETRY')if success else'FAILED_SCOPE_SETTLED_RESOURCE_RELEASED')
    except BaseException as error:
        # The common durable INTENT survives every unknown path/restart. No
        # replay, hold removal, profile/worker/intent/account mutation or guess.
        try:
            if not(task/'SUPERVISOR-UNKNOWN.json').exists():exclusive(task/'SUPERVISOR-UNKNOWN.json',{'state':'UNKNOWN_NO_REPLAY','class':type(error).__name__,'messageSHA256':hashlib.sha256(str(error).encode()).hexdigest(),'at':time.time()})
        except BaseException:pass
        service.jobs[record['operationId']]=(claim,spec,'UNKNOWN_NO_REPLAY')
