"""Outer, independently bounded ordinary-user scope for the fixed own fixture.

Import is inert. A failed/unknown attempt is never replayable. This driver stays
OUTSIDE its child's systemd scope, holding both canonical workspace leases.
"""
import importlib.util,json,os,secrets,signal,subprocess,sys,time
from contextlib import contextmanager
from pathlib import Path

HERE=Path(__file__).resolve().parent
def load_run():
    spec=importlib.util.spec_from_file_location('fixed_stale_run',HERE/'stale-busy-run.py')
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
def cgroup_empty(group):
    path=Path('/sys/fs/cgroup')/group.lstrip('/')
    try:
        events=dict(line.split()for line in(path/'cgroup.events').read_text().splitlines())
        return events.get('populated')=='0'
    except FileNotFoundError:return not path.exists()
def recorded(root,life):
    values=[]
    for name in ('SUPERVISED-NODE.json','MUX-OWNER.json'):
        if(root/name).exists():values.append(json.loads((root/name).read_bytes()))
    if(root/'programs').exists():values.extend(json.loads(p.read_bytes())for p in(root/'programs').glob('*.json'))
    return [{'pid':v['pid'],'startTick':v['startTick']}for v in values if life.same(v)]
@contextmanager
def requested_stop():
    state={'signal':None}
    def mark(number,_):state['signal']=number
    old={sig:signal.signal(sig,mark)for sig in(signal.SIGTERM,signal.SIGINT,signal.SIGHUP)}
    try:yield state
    finally:
        for sig,handler in old.items():signal.signal(sig,handler)
def same_scope(value,binding):
    return value.get('Id')==binding['unit'] and value.get('InvocationID')==binding['invocationId'] and value.get('ControlGroup')in(binding['controlGroup'],'')
def terminal_scope(value,binding):
    # Transient inactive units may be garbage-collected. This is settlement only
    # after the actual active invocation was captured and its cgroup/PIDs vanish.
    return value.get('Id')==binding['unit'] and value.get('ActiveState')in('inactive','failed') and (same_scope(value,binding)or(value.get('LoadState')=='not-found' and not value.get('InvocationID')and not value.get('ControlGroup')))
def observe_scope(run,life,root,task,tools,policy,unit,env,child,stop,deadline):
    """Continue bounded settlement after errors; no guessed PID/unit cleanup."""
    binding=None;last={};failures=[];stopped=False;settled=False;survivors=[]
    while time.monotonic()<deadline:
        try:
            life.wait_timeout(deadline,5)
            code,last=run.query_scope(tools['systemctl'],unit,deadline)
            if binding is None and code==0 and last.get('ActiveState')=='active':
                binding=life.validate_scope(last,unit,policy);run.write(task/'ACTUAL-SCOPE.json',binding)
            if binding is not None:
                survivors=recorded(root,life)
                if terminal_scope(last,binding)and cgroup_empty(binding['controlGroup'])and not survivors:
                    settled=True;break
                run.need(same_scope(last,binding),'scope identity changed; no guessed stop')
                if (stop['signal']is not None or failures)and not stopped:
                    # Recheck the actual captured invocation immediately before
                    # this sole exact-owned stop. No guessed namespace signal.
                    life.wait_timeout(deadline,5)
                    _,fresh=run.query_scope(tools['systemctl'],unit,deadline)
                    run.need(same_scope(fresh,binding),'scope changed before stop')
                    stopped=True
                    subprocess.run([tools['systemctl'],'--user','stop',unit],env=env,capture_output=True,timeout=life.wait_timeout(deadline,policy['stopSeconds']+5),check=True)
        except BaseException as error:
            if len(failures)<8:failures.append({'class':type(error).__name__,'reason':str(error)[:300]})
        remaining=deadline-time.monotonic()
        if remaining>0:time.sleep(min(.2,remaining))
    if not settled:failures.append({'class':'ScopeSettlementUnknown','reason':'deadline is not proof of zero survivors'})
    return {'binding':binding,'last':last,'failures':failures,'settled':settled,'survivors':survivors}
def main():
    run=load_run();args=run.arguments();pins,tools,policy,task,source=run.verify(args);life=run.lifecycle()
    # Only the four already verified, canonical lease modules are imported.
    run.need('REVERIE_LEASE_LIB'not in os.environ,'external lease module override refused')
    sys.path.insert(0,str(source/'python'))
    from reverie.workspaces import Workspaces
    manager=Workspaces(task.parent);token=secrets.token_hex(8);unit='reverie-sb-'+token+'.scope'
    socket=(Path.home()/'scratch').resolve(strict=True)/('.sb-'+token);root=task/('fixture-'+token)
    with manager.operation(task.name):
        meta=json.loads((task/'.reverie-task.json').read_bytes())
        run.need(meta.get('id')==task.name and meta.get('status')=='allocated','fresh allocated task required; no replay')
        run.need(not any((task/name).exists()or(task/name).is_symlink()for name in('SCOPE-ATTEMPT.json','NATIVE_ATTEMPT.json','SCOPE-RESULT.json')),'prior attempt or unknown outcome; no replay')
        root.mkdir(mode=0o700);socket.mkdir(mode=0o700)
        run.need(len(str(socket))<=60,'short private mux root required')
        for name in('home','instance','tmp'):(root/name).mkdir(mode=0o700)
        manager._reserve(task,renew=True);manager.lease.reserve(str(socket),'24h',owner=str(os.getuid()))
        with manager.lease.hold([str(task),str(socket)],argv0='fixed-stale-busy-scope'):
            attempt={'unit':unit,'fixtureRoot':str(root),'socketRoot':str(socket),'pinsSHA256':args.pins_sha256,'sourceManifestSHA256':args.source_manifest_sha256,'at':time.time(),'scope':policy}
            run.write(task/'SCOPE-ATTEMPT.json',attempt)
            manager.write(task,{**meta,'status':'running','scopeUnit':unit,'fixtureRoot':str(root),'socketRoot':str(socket)})
            outer_sha=run.sha((task/'SCOPE-ATTEMPT.json').read_bytes())
            inner=[tools['taskset'],'-c',','.join(map(str,policy['cpuSet'])),tools['python'],'-I','-B',str(HERE/'stale-busy-run.py'),'--execute-reviewed-fixture','--lease-root',str(task),'--pins',str(Path(args.pins).resolve()),'--pins-sha256',args.pins_sha256,'--source-manifest',str(Path(args.source_manifest).resolve()),'--source-manifest-sha256',args.source_manifest_sha256,'--scope-unit',unit,'--run-token',token,'--outer-attempt-sha256',outer_sha]
            command=[tools['systemd-run'],'--user','--scope','--unit',unit,'--property=RuntimeMaxSec='+str(policy['runtimeSeconds']),'--property=TimeoutStopSec='+str(policy['stopSeconds']),'--property=MemoryMax='+str(policy['memoryMaxBytes']),'--property=MemorySwapMax=0','--property=TasksMax='+str(policy['pidsMax'])]+inner
            # systemd-run needs the ordinary user's bus. The inner Node receives
            # a separately cleared environment; no account material is read.
            env={key:os.environ[key]for key in('HOME','USER','LOGNAME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG')if key in os.environ}
            env['PATH']=':'.join(dict.fromkeys(str(Path(p).parent)for p in tools.values()))
            child=None;client_binding=None;client_cleanup={'known':False,'reason':'NOT_STARTED'};binding=None;last={};failure=None;settled=False;survivors=[];observation=None
            # Final process-group cleanup is INSIDE the admitted total budget.
            final_deadline=time.monotonic()+policy['observationSeconds']
            deadline=final_deadline-policy['terminateSeconds']-policy['killSeconds']-10
            with requested_stop()as stop:
                try:
                    with(task/'SCOPE-CLIENT.log').open('xb')as log:
                        child=subprocess.Popen(command,cwd=source,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                        client_binding=life.proc(child.pid);run.need(client_binding is not None,'scope client identity unavailable')
                        run.write(task/'SCOPE-CLIENT-PID.json',client_binding)
                        observation=observe_scope(run,life,root,task,tools,policy,unit,env,child,stop,deadline)
                        binding=observation['binding'];last=observation['last'];settled=observation['settled'];survivors=observation['survivors']
                        if observation['failures']:failure={'class':'ScopeObservationFailure','observations':observation['failures']}
                except BaseException as error:failure={'class':type(error).__name__,'reason':str(error)[:300]}
                finally:
                    # Even a lost inner ownership receipt cannot make PASS. The
                    # independent unit timer remains active after this process dies.
                    if child is not None:
                        if observation is None:
                            observation=observe_scope(run,life,root,task,tools,policy,unit,env,child,stop,deadline)
                            binding=observation['binding'];last=observation['last'];settled=observation['settled'];survivors=observation['survivors']
                        try:client_cleanup=life.settle_node(child,client_binding,policy,deadline=final_deadline)
                        except BaseException as error:client_cleanup={'known':False,'reason':str(error)[:200]}
            inner_result=json.loads((root/'SUPERVISOR-RESULT.json').read_bytes())if(root/'SUPERVISOR-RESULT.json').exists()else None
            passed=settled and client_cleanup['known']and failure is None and stop['signal']is None and child is not None and child.returncode==0 and last.get('Result')in('success','')and inner_result is not None and inner_result.get('state')=='PASS_OWN_NON_WORKER_SUBCASES'
            result={'state':'PASS_OWN_NON_WORKER_SUBCASES'if passed else('FAIL_SCOPE_SETTLED'if settled and client_cleanup['known']else'SCOPE_SETTLEMENT_UNKNOWN'),'scope':binding,'scopeProperties':last,'scopeSettled':settled,'clientCleanup':client_cleanup,'survivors':survivors,'returncode':None if child is None else child.returncode,'failure':failure,'signal':stop['signal'],'innerState':None if inner_result is None else inner_result.get('state'),'workerReplacement':'OPEN_NOT_PASSED','at':time.time()}
            run.write(task/'SCOPE-RESULT.json',result)
            manager.write(task,{**meta,'status':'awaiting_handoff'if settled and client_cleanup['known']else'cleanup_unknown','scopeUnit':unit,'fixtureRoot':str(root),'socketRoot':str(socket),'result':result['state']})
            manager._reserve(task,renew=True)
            run.need(passed,'fixture failed or cleanup unknown; preserve receipts/reservations; no replay')
if __name__=='__main__':main()
