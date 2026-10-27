"""Fixed private-fixture cleanup and systemd metadata rules. No action on import."""
import os,re,select,subprocess,time
from decimal import Decimal
from pathlib import Path

def need(value,message):
    if not value:raise RuntimeError(message)
def proc(pid):
    try:
        fields=(Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split()
        return {'pid':pid,'startTick':fields[19],'state':fields[0]}
    except FileNotFoundError:return None
def same(value):
    actual=proc(value['pid']);return actual is not None and actual['startTick']==value['startTick']
def properties(text):
    result={}
    for line in text.splitlines():
        key,separator,value=line.partition('=');need(separator and key not in result,'invalid unit properties');result[key]=value
    return result
def seconds(text):
    need(type(text)is str and 0<len(text)<=64,'finite unit time required')
    tokens=re.findall(r'([0-9]+(?:\.[0-9]+)?)(us|ms|s|min|h)',text)
    need(tokens and ''.join(a+b for a,b in tokens)==''.join(text.split()),'unknown unit time')
    scale={'us':Decimal('.000001'),'ms':Decimal('.001'),'s':Decimal(1),'min':Decimal(60),'h':Decimal(3600)}
    return sum(Decimal(value)*scale[unit]for value,unit in tokens)
def validate_scope(value,unit,policy,current_group=None):
    need(value.get('Id')==unit and re.fullmatch(r'reverie-sb-[a-f0-9]{16}\.scope',unit),'wrong scope ID')
    need(re.fullmatch('[a-f0-9]{32}',value.get('InvocationID','')),'scope invocation missing')
    group=value.get('ControlGroup','');need(group.startswith('/') and Path(group).name==unit and '..'not in Path(group).parts,'scope cgroup missing')
    if current_group is not None:need(group==current_group,'scope does not contain supervisor')
    need(value.get('ActiveState')=='active','scope is not active')
    need(seconds(value.get('RuntimeMaxUSec'))==policy['runtimeSeconds'] and seconds(value.get('TimeoutStopUSec'))==policy['stopSeconds'],'scope lifetime differs')
    need(value.get('MemoryMax')==str(policy['memoryMaxBytes']) and value.get('MemorySwapMax')=='0' and value.get('TasksMax')==str(policy['pidsMax']),'scope limits differ')
    return {'unit':unit,'invocationId':value['InvocationID'],'controlGroup':group}

def wait_timeout(deadline, maximum):
    """Every cooperative wait consumes the same fixed absolute budget."""
    remaining=maximum if deadline is None else min(maximum,deadline-time.monotonic())
    need(remaining>0,'absolute fixture deadline exhausted')
    return remaining

def settle_node(child,binding,policy,*,deadline=None):
    if deadline is None:deadline=time.monotonic()+policy['terminateSeconds']+policy['killSeconds']
    if child is None:return {'known':True,'reason':'NO_NODE_STARTED'}
    need(binding is not None,'Node PID identity missing')
    if child.poll()is None and same(binding):
        need(os.getpgid(child.pid)==child.pid,'Node process group changed')
        os.killpg(child.pid,15)
        try:child.wait(timeout=wait_timeout(deadline,policy['terminateSeconds']))
        except subprocess.TimeoutExpired:
            if same(binding):
                need(os.getpgid(child.pid)==child.pid,'Node process group changed')
                os.killpg(child.pid,9)
            child.wait(timeout=wait_timeout(deadline,policy['killSeconds']))
    need(not same(binding),'Node PID remains')
    try:os.killpg(child.pid,0)
    except ProcessLookupError:return {'known':True,'reason':'NODE_GROUP_SETTLED'}
    raise RuntimeError('Node group remains')

def settle_mux(root,token,tools,env,*,deadline=None):
    import json
    if deadline is None:deadline=time.monotonic()+25
    owner_path=root/'MUX-OWNER.json';identity_path=root/'FIXTURE-IDENTITY.json'
    need(owner_path.exists()and identity_path.exists(),'missing mux ownership; no guessed signal')
    owner=json.loads(owner_path.read_bytes());identity=json.loads(identity_path.read_bytes())
    need(type(owner.get('pid'))is int and owner['pid']>1 and type(owner.get('startTick'))is str,'invalid mux owner')
    need(identity.get('socket')=='sb-'+token and re.fullmatch('reverie-[a-f0-9]{8}',identity.get('muxName','')),'mux identity differs')
    query=[tools['tmux'],'-f','/dev/null','-L','sb-'+token]
    if not same(owner):
        probe=subprocess.run(query+['display-message','-p','#{pid}'],env=env,capture_output=True,text=True,timeout=wait_timeout(deadline,5))
        need(probe.returncode!=0,'unrecorded private mux incarnation; no signal')
        return {'known':True,'reason':'RECORDED_MUX_GONE'}
    need(owner.get('exe')==tools['tmux'] and str((Path('/proc')/str(owner['pid'])/'exe').resolve(strict=True))==tools['tmux'],'mux executable differs; no signal')
    named=subprocess.run(query+['list-sessions','-F','#{session_name}'],env=env,capture_output=True,text=True,timeout=wait_timeout(deadline,5))
    need(named.returncode==0 and set(named.stdout.splitlines())<={identity['muxName']},'foreign mux sessions; no signal')
    held=os.pidfd_open(owner['pid'])
    try:
        need(same(owner),'mux PID rebound; no signal')
        current=subprocess.run(query+['display-message','-p','#{pid}'],env=env,capture_output=True,text=True,timeout=wait_timeout(deadline,5))
        need(current.returncode==0 and current.stdout.strip()==str(owner['pid']),'mux server differs; no signal')
        subprocess.run(query+['kill-server'],env=env,check=True,capture_output=True,timeout=wait_timeout(deadline,5))
        poll=select.poll();poll.register(held,select.POLLIN);need(bool(poll.poll(int(wait_timeout(deadline,5)*1000))),'mux server did not settle')
        return {'known':True,'reason':'EXACT_PRIVATE_MUX_SETTLED'}
    finally:os.close(held)

def cleanup(root,token,tools,env,child,binding,policy,*,deadline=None):
    """Both fixed cleanups are attempted on every path; neither masks the other."""
    if deadline is None:deadline=time.monotonic()+policy['terminateSeconds']+policy['killSeconds']+25
    result={}
    try:result['node']=settle_node(child,binding,policy,deadline=deadline)
    except BaseException as error:result['node']={'known':False,'reason':str(error)[:200]}
    try:result['mux']=settle_mux(root,token,tools,env,deadline=deadline)
    except BaseException as error:result['mux']={'known':False,'reason':str(error)[:200]}
    result['known']=all(result[key]['known']for key in ('node','mux'))
    return result
