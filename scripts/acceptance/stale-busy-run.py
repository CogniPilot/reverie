"""Fixed inner supervisor. The separately bounded outer scope owns its lease."""
import argparse,hashlib,importlib.util,json,os,re,signal,stat,subprocess,sys,time
from contextlib import contextmanager
from pathlib import Path

HERE=Path(__file__).resolve().parent
FILES=('stale-busy-run.py','stale-busy-native.mjs','stale-busy-program.py','stale-busy-spec.mjs','stale-busy-spec.test.mjs','stale-busy-lifecycle.py','stale-busy-scope.py','stale-busy-lifecycle.test.py')
LIFE=None
def need(value,message):
    if not value:raise RuntimeError(message)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def write(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w')as out:json.dump(value,out,indent=2);out.write('\n');out.flush();os.fsync(out.fileno())
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)
def tool(value):
    p=Path(value).resolve(strict=True);s=p.stat()
    need(str(p).startswith('/nix/store/')and stat.S_ISREG(s.st_mode)and s.st_uid==0 and not s.st_mode&0o222 and s.st_mode&0o111,'immutable runtime tool required')
    return str(p)
def lifecycle():
    global LIFE
    if LIFE is None:
        spec=importlib.util.spec_from_file_location('fixed_stale_lifecycle',HERE/'stale-busy-lifecycle.py')
        LIFE=importlib.util.module_from_spec(spec);spec.loader.exec_module(LIFE)
    return LIFE
def arguments(inner=False):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--execute-reviewed-fixture',action='store_true')
    for key in ['lease-root','pins','pins-sha256','source-manifest','source-manifest-sha256']:p.add_argument('--'+key,required=True)
    if inner:
        for key in ['scope-unit','run-token','outer-attempt-sha256']:p.add_argument('--'+key,required=True)
    return p.parse_args()
def verify(args):
    need(args.execute_reviewed_fixture,'explicit admitted fixture invocation required')
    for value in [args.pins_sha256,args.source_manifest_sha256]:need(re.fullmatch('[a-f0-9]{64}',value),'reviewed hash required')
    raw=Path(args.source_manifest).read_bytes();need(len(raw)<=65536 and sha(raw)==args.source_manifest_sha256,'source manifest differs')
    manifest=json.loads(raw);need(set(manifest)==set(FILES),'closed source manifest required')
    for name,digest in manifest.items():need(sha((HERE/name).read_bytes())==digest,'source differs')
    raw=Path(args.pins).read_bytes();need(len(raw)<=1<<20 and sha(raw)==args.pins_sha256,'private pins differ')
    pins=json.loads(raw);runtime=pins['runtime'];tools={key:tool(value)for key,value in runtime['tools'].items()}
    need(set(tools)=={'node','python','bash','tmux','ps','which','coreutils','systemctl','systemd-run','taskset','flock'},'fixed utility set required')
    for key,path in tools.items():need(sha(Path(path).read_bytes())==runtime['sha256'][key],'runtime bytes differ')
    policy=pins['scope'];keys={'memoryMaxBytes','pidsMax','cpuSet','activeSeconds','terminateSeconds','killSeconds','canarySeconds','logMaxBytes','runtimeSeconds','stopSeconds','observationSeconds'}
    need(set(policy)==keys,'closed resource scope required')
    for key in keys-{'cpuSet'}:need(type(policy[key])is int and policy[key]>0,'positive finite scope required')
    need(policy['memoryMaxBytes']<=2*(1<<30)and policy['pidsMax']<=256 and policy['activeSeconds']<=300 and policy['terminateSeconds']<=45 and policy['killSeconds']<=5 and policy['canarySeconds']<=240 and policy['logMaxBytes']<=1<<20,'bounded fixture required')
    need(policy['runtimeSeconds']+policy['stopSeconds']<=policy['observationSeconds']<=480 and policy['runtimeSeconds']>=policy['activeSeconds'],'independent scope lifetime required')
    need(type(policy['cpuSet'])is list and 0<len(policy['cpuSet'])<=8 and all(type(x)is int and x>=0 for x in policy['cpuSet']),'explicit CPUs required')
    task=Path(args.lease_root).resolve(strict=True);s=task.stat()
    need(s.st_uid==os.getuid()and stat.S_IMODE(s.st_mode)==0o700,'private leased task required')
    source=HERE.parents[1]
    need(set(pins['leaseFiles'])=={'python/reverie/__init__.py','python/reverie/workspaces.py','python/reverie/lease.py','python/reverie/cleanup/lease.py'},'canonical lease pins required')
    for name,digest in pins['leaseFiles'].items():need(sha((source/name).read_bytes())==digest,'canonical lease differs')
    return pins,tools,policy,task,source
def query_scope(systemctl,unit,deadline=None):
    response=subprocess.run([systemctl,'--user','show',unit,'--property=Id,InvocationID,LoadState,ActiveState,SubState,Result,ControlGroup,RuntimeMaxUSec,TimeoutStopUSec,MemoryMax,MemorySwapMax,TasksMax'],capture_output=True,text=True,timeout=lifecycle().wait_timeout(deadline,5))
    return response.returncode,lifecycle().properties(response.stdout)
@contextmanager
def stop_signals():
    def stop(number,_):raise InterruptedError('Owned inner supervisor signal '+str(number))
    old={sig:signal.signal(sig,stop)for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP)}
    try:yield
    finally:
        for sig,handler in old.items():signal.signal(sig,handler)
def supervise(root,token,tools,env,command,policy):
    """No cleanup callbacks. Fixed cleanup always runs, independently per target."""
    life=lifecycle();child=None;binding=None;failure=None;timed_out=False;cleanup=None
    cleanup_deadline=time.monotonic()+policy['activeSeconds']+policy['terminateSeconds']+policy['killSeconds']
    try:
        with (root/'native.log').open('xb')as log:
            child=subprocess.Popen(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            binding=life.proc(child.pid);need(binding is not None,'Node identity unavailable');write(root/'SUPERVISED-NODE.json',binding)
            deadline=time.monotonic()+policy['activeSeconds']
            while child.poll()is None and time.monotonic()<deadline and log.tell()<=policy['logMaxBytes']:time.sleep(.1)
            timed_out=child.poll()is None
    except BaseException as error:failure={'class':type(error).__name__,'message':str(error)[:300]}
    finally:
        cleanup=life.cleanup(root,token,tools,env,child,binding,policy,deadline=cleanup_deadline)
    records=[json.loads(p.read_bytes())for p in(root/'programs').glob('*.json')]if(root/'programs').exists()else[]
    survivors=[{'pid':r['pid'],'startTick':r['startTick']}for r in records if life.same(r)]
    terminal=json.loads((root/'TERMINAL.json').read_bytes())if(root/'TERMINAL.json').exists()else None
    passed=failure is None and not timed_out and child is not None and child.returncode==0 and cleanup['known']and not survivors and terminal is not None and terminal.get('terminal')=='COLLECTED'and not terminal.get('survivors')
    value={'state':'PASS_OWN_NON_WORKER_SUBCASES'if passed else('FAIL_SETTLED'if cleanup['known']and not survivors else'CLEANUP_UNKNOWN'),'returncode':None if child is None else child.returncode,'failure':failure,'timedOut':timed_out,'cleanup':cleanup,'survivors':survivors,'workerReplacement':'OPEN_NOT_PASSED'}
    write(root/'SUPERVISOR-RESULT.json',value);return value
def main():
    args=arguments(inner=True);pins,tools,policy,task,_source=verify(args);life=lifecycle()
    need(re.fullmatch('[a-f0-9]{16}',args.run_token)and args.scope_unit=='reverie-sb-'+args.run_token+'.scope','fixed scope identity required')
    raw=(task/'SCOPE-ATTEMPT.json').read_bytes();need(sha(raw)==args.outer_attempt_sha256,'outer attempt differs')
    outer=json.loads(raw);need(outer['unit']==args.scope_unit and outer['pinsSHA256']==args.pins_sha256 and outer['sourceManifestSHA256']==args.source_manifest_sha256,'outer binding differs')
    groups=Path('/proc/self/cgroup').read_text().splitlines();need(len(groups)==1 and groups[0].startswith('0::/'),'unified scope required')
    code,properties=query_scope(tools['systemctl'],args.scope_unit);need(code==0,'scope unavailable')
    binding=life.validate_scope(properties,args.scope_unit,policy,groups[0][3:]);need(os.sched_getaffinity(0)<=set(policy['cpuSet']),'wrong CPUs')
    root=task/('fixture-'+args.run_token);socket=Path(outer['socketRoot'])
    need(root==Path(outer['fixtureRoot'])and socket.resolve()==socket and len(str(socket))<=60,'fixed private fixture paths required')
    write(task/'NATIVE_ATTEMPT.json',{'scope':binding,'pinsSHA256':args.pins_sha256,'sourceManifestSHA256':args.source_manifest_sha256,'at':time.time()});write(root/'SCOPE-BOUND.json',binding)
    env={'HOME':str(root/'home'),'PATH':':'.join(dict.fromkeys(str(Path(p).parent)for p in tools.values())),'REVERIE_FLOCK_BIN':tools['flock'],'SHELL':tools['bash'],'TERM':'xterm-256color','LANG':'C.UTF-8','TMPDIR':str(root/'tmp'),'TMUX_TMPDIR':str(socket),'REVERIE_DATA_DIR':str(root/'instance'),'REVERIE_INSTANCE':'sb-'+args.run_token,'REVERIE_TMUX_SOCKET':'sb-'+args.run_token,'REVERIE_API_URL':'http://127.0.0.1:9','SB_ROOT':str(root),'SB_PYTHON':tools['python'],'SB_BASH':tools['bash'],'SB_TMUX':tools['tmux'],'SB_LIFETIME':str(policy['canarySeconds'])}
    command=[tools['node'],str(HERE/'stale-busy-native.mjs'),'--run-owned-fixture','--pins',str(Path(args.pins).resolve()),'--pins-sha256',args.pins_sha256,'--lease-root',str(task)]
    with stop_signals():result=supervise(root,args.run_token,tools,env,command,policy)
    need(result['state']=='PASS_OWN_NON_WORKER_SUBCASES','inner fixture failed or cleanup unknown; no replay')
if __name__=='__main__':main()
