"""Owned composed cancellation fixture. No effects on import; explicit root admission only."""
import argparse
import copy
import hashlib
import http.server
import json
import os
from pathlib import Path
import selectors
import fcntl
import math
import re
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid

HERE=Path(__file__).resolve().parent
TASK='heartbeat'
PROC=Path('/proc')


def need(value,message):
    if not value:raise RuntimeError(message)


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def exclusive(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    with os.fdopen(fd,'w')as stream:json.dump(value,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)


def identity(pid):
    try:
        row=(PROC/str(pid)/'stat').read_text().rsplit(')',1)[1].split()
        return {'pid':pid,'startTick':row[19],'state':row[0]}
    except FileNotFoundError:return None


def live(record):
    current=identity(record['pid'])
    return current is not None and current['startTick']==record['startTick']


def private_json(path, maximum=65536):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        item=os.fstat(fd)
        need(stat.S_ISREG(item.st_mode)and item.st_uid==os.getuid()and item.st_nlink==1 and stat.S_IMODE(item.st_mode)==0o600,'private controller record required')
        raw=os.read(fd,maximum+1);need(len(raw)<=maximum,'controller record bound')
    finally:os.close(fd)
    return raw,json.loads(raw)


def verify_outer(args,pins,task,scope):
    """Verify the fixed outside controller, never a wire owner assertion."""
    need(re.fullmatch('[a-f0-9]{64}',args.outer_attempt_sha256),'reviewed outer attempt digest required')
    raw,attempt=private_json(task/'SCOPE-ATTEMPT.json')
    need(hashlib.sha256(raw).hexdigest()==args.outer_attempt_sha256,'outer attempt changed')
    need(set(attempt)=={'kind','operationId','unit','pinsSHA256','outerPID','controller','at'},'closed outer attempt required')
    need(attempt['kind']=='OWNED_TASK_CANCEL_SCOPE'and attempt['operationId']==pins['operationId']and attempt['unit']==scope['unit']and attempt['pinsSHA256']==args.pins_sha256,'outer attempt binding differs')
    need(type(attempt['at'])in(int,float)and math.isfinite(attempt['at'])and -5<=time.time()-attempt['at']<=180,'outer attempt expired')
    _raw,metadata=private_json(task/'.reverie-task.json')
    need(metadata.get('id')==task.name and metadata.get('status')=='running'and metadata.get('scopeUnit')==scope['unit']and metadata.get('scopeAttemptSHA256')==args.outer_attempt_sha256,'outer running metadata differs')
    outer=attempt['outerPID'];controller=attempt['controller']
    need(type(outer)is dict and set(outer)=={'pid','startTick'}and type(outer['pid'])is int and outer['pid']>1 and outer['pid']!=os.getpid()and type(outer['startTick'])is str and outer['startTick'].isdigit(),'outer process binding required')
    need(type(controller)is dict and set(controller)=={'exe','entry','entrySHA256','operationLockFD'},'closed controller binding required')
    need(set(pins['outerScripts'])=={'task-cancel-scope.py','task-cancel-scope.test.py','task-cancel-source.test.py'},'closed outer source binding required')
    entry=HERE/'task-cancel-scope.py';core=Path(pins['tools']['python'])
    need(controller['exe']==str(core)and controller['entry']==str(entry)and entry.resolve()==entry and controller['entrySHA256']==pins['outerScripts']['task-cancel-scope.py']and sha(entry)==controller['entrySHA256'],'fixed controller source differs')
    before=identity(outer['pid']);need(before is not None and before['startTick']==outer['startTick']and before['state']not in('Z','X'),'outer process unavailable')
    process=PROC/str(outer['pid']);need(process.stat().st_uid==os.getuid(),'foreign controller process')
    need((process/'exe').resolve()==core and sha(process/'exe')==pins['toolSHA256']['python'],'controller executable differs')
    with(process/'cmdline').open('rb')as stream:command=stream.read(16385)
    need(len(command)<=16384 and command.split(b'\0')[:4]==[str(core).encode(),b'-I',b'-B',str(entry).encode()],'controller entry prefix differs')
    with(process/'cgroup').open('r')as stream:groups=stream.read(4097)
    need(len(groups)<=4096 and len(groups.splitlines())==1 and groups.startswith('0::/'),'external controller cgroup unavailable')
    outside=Path(groups.strip()[3:]);inside=Path(scope['controlGroup'])
    need(not outside.is_relative_to(inside),'controller must remain outside native scope')
    number=controller['operationLockFD'];need(type(number)is int and 2<number<4096,'fixed operation FD required')
    operation=task.parent/'.ops'/(task.name+'.lock');named=operation.lstat();held=(process/'fd'/str(number)).stat()
    signature=lambda item:(item.st_dev,item.st_ino)
    need(stat.S_ISREG(named.st_mode)and named.st_uid==os.getuid()and named.st_nlink==1 and stat.S_IMODE(named.st_mode)==0o600 and signature(named)==signature(held),'controller operation descriptor differs')
    fd=os.open(operation,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        need(signature(os.fstat(fd))==signature(named),'operation lock rebound')
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:pass
        else:
            fcntl.flock(fd,fcntl.LOCK_UN)
            raise RuntimeError('outside controller must retain canonical operation lock')
    finally:os.close(fd)
    after=identity(outer['pid'])
    need(after is not None and after['startTick']==before['startTick']and after['state']not in('Z','X')and signature(operation.lstat())==signature(named)and signature((process/'fd'/str(number)).stat())==signature(named),'controller binding changed')
    return metadata


class AuthorityBridge:
    """Fixed protected own-fixture IPC; owner cookies never leave Node memory."""
    def __init__(self,command,environment,root,deadline):
        self.deadline=deadline;self.pending=bytearray();self.lock=threading.Lock()
        self.log=(root/'authority.log').open('xb')
        self.child=subprocess.Popen(command,env=environment,cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                    stderr=self.log,start_new_session=True,close_fds=True,bufsize=0)
        self.binding=identity(self.child.pid);need(self.binding is not None,'authority PID unavailable')
        exclusive(root/'AUTHORITY-PID.json',self.binding)
        self.selector=selectors.DefaultSelector();self.selector.register(self.child.stdout,selectors.EVENT_READ)
        try:self.binding_message=self.receive()['binding']
        except BaseException:
            self.close();raise
    def receive(self):
        while b'\n'not in self.pending:
            remaining=min(5,self.deadline-time.monotonic());need(remaining>0,'fixture deadline')
            need(self.selector.select(remaining),'authority reply timed out')
            chunk=os.read(self.child.stdout.fileno(),4096);need(chunk,'authority EOF')
            self.pending.extend(chunk);need(len(self.pending)<=65536,'authority frame bound')
        row,_,tail=self.pending.partition(b'\n');self.pending=bytearray(tail)
        value=json.loads(row);need(value.get('ok')is True,'authority refused');return value
    def call(self,op,room=None,**fields):
        with self.lock:
            value={'op':op,**({'roomId':room}if room else{}),**fields};raw=(json.dumps(value)+'\n').encode()
            need(len(raw)<=4096,'request bound');self.child.stdin.write(raw);self.child.stdin.flush();return self.receive()
    def close(self):
        try:self.call('close')
        except Exception:pass
        self.child.stdin.close()
        def remaining(maximum):
            value=min(maximum,self.deadline-time.monotonic());need(value>0,'authority cleanup deadline');return value
        if self.child.poll()is None:
            try:self.child.wait(timeout=remaining(3))
            except subprocess.TimeoutExpired:
                if live(self.binding):os.killpg(self.child.pid,signal.SIGTERM)
                try:self.child.wait(timeout=remaining(2))
                except subprocess.TimeoutExpired:
                    if live(self.binding):os.killpg(self.child.pid,signal.SIGKILL)
                    self.child.wait(timeout=remaining(2))
        self.selector.close();self.log.close()
        need(not live(self.binding)and self.child.returncode==0,'authority cleanup/commit unknown')


class CanonicalChat:
    """Read-only canonical projection plus fixed own-member reply port."""
    def __init__(self,bridge):self.bridge=bridge;self.timeout=.75;self.binding=bridge.binding_message
    def member_rooms(self):return self.bridge.call('rooms')['rooms']
    def read(self,room,count):return self.bridge.call('read',room)['messages'][-count:]
    def exact_message(self,room,message_id):return self.bridge.call('exact',room,messageId=message_id)['message']
    def member_alert(self,room,session_id):
        view=self.bridge.call('read',room);members=view['members'];selected=[m for m in members if m.get('sessionId')==session_id]
        need(len(selected)==1,'canonical member missing');member=selected[0]
        return {'lease':member.get('alertMode'),'name':member['name'],'unique':sum(m.get('name')==member['name']for m in members)==1}
    def say(self,room,text,reply_to=None):return self.bridge.call('agent-post',room,text=text,replyTo=reply_to)['message']


class LocalProvider(http.server.BaseHTTPRequestHandler):
    calls=0
    def log_message(self,*_):pass
    def do_POST(self):
        self.connection.settimeout(2)
        size=int(self.headers.get('Content-Length','0'))
        if self.path!='/v1/chat/completions' or not 0<size<=262144 or self.headers.get('Authorization'):
            self.send_error(400);return
        request=json.loads(self.rfile.read(size));need(request.get('model')=='fixture-only','wrong local model')
        type(self).calls+=1;need(type(self).calls==1,'unexpected additional model request')
        message={'role':'assistant','content':'','tool_calls':[{'id':'heartbeat1','type':'function','function':{'name':'run_tests','arguments':'{}'}}]}
        raw=json.dumps({'choices':[{'index':0,'message':message,'finish_reason':'tool_calls'}]}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)


def validate_cpu_set(value):
    need(type(value)is list and 1<=len(value)<=8 and all(type(cpu)is int and cpu>=0 for cpu in value)and len(set(value))==len(value),'explicit unique finite CPU list required')
    return tuple(value)


def require_cpu_affinity(value):
    selected=validate_cpu_set(value)
    need(os.sched_getaffinity(0)<=set(selected),'fixture CPU binding required')
    return selected


def current_scope(pins):
    rows=Path('/proc/self/cgroup').read_text().splitlines();need(len(rows)==1 and rows[0].startswith('0::/'),'unified own scope required')
    root=Path('/sys/fs/cgroup')/rows[0][3:].lstrip('/')
    values={name:(root/name).read_text().strip()for name in ('memory.max','memory.swap.max','pids.max')}
    need(values['memory.max'].isdigit()and 0<int(values['memory.max'])<=536870912 and values['memory.swap.max']=='0'and values['pids.max'].isdigit()and 0<int(values['pids.max'])<=128,'finite own no-swap scope required')
    require_cpu_affinity(pins.get('cpuSet'))
    unit=Path(rows[0][3:]).name
    operation=pins.get('operationId');need(type(operation)is str and re.fullmatch('[a-f0-9]{32}',operation),'reviewed operation ID required')
    need(unit=='reverie-task-cancel-'+operation+'.scope','dedicated reviewed scope required')
    response=subprocess.run([pins['tools']['systemctl'],'--user','show',unit,'--property=Id,InvocationID,ControlGroup,ActiveState,RuntimeMaxUSec,TimeoutStopUSec'],capture_output=True,text=True,timeout=3)
    need(response.returncode==0 and len(response.stdout)<=8192,'scope properties unavailable')
    properties=dict(row.split('=',1)for row in response.stdout.splitlines())
    need(properties.get('Id')==unit and properties.get('ControlGroup')==rows[0][3:]and properties.get('ActiveState')=='active'and re.fullmatch('[a-f0-9]{32}',properties.get('InvocationID','')),'scope incarnation differs')
    need(properties.get('RuntimeMaxUSec')in('2min','120s')and properties.get('TimeoutStopUSec')in('30s','0.5min'),'independent finite scope lifetime required')
    return {**values,'unit':unit,'invocationId':properties['InvocationID'],'controlGroup':properties['ControlGroup']}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--run-owned-fixture',action='store_true')
    for name in ('lease-root','pins','pins-sha256','outer-attempt-sha256'):parser.add_argument('--'+name,required=True)
    args=parser.parse_args();need(args.run_owned_fixture,'explicit native admission required')
    pinpath=Path(args.pins).resolve(strict=True);need(sha(pinpath)==args.pins_sha256,'reviewed pins differ');pins=json.loads(pinpath.read_bytes())
    task=Path(args.lease_root).resolve(strict=True);item=task.stat();need(item.st_uid==os.getuid()and stat.S_IMODE(item.st_mode)==0o700,'owned leased root required')
    for name,digest in pins['scripts'].items():need(name in ('task-cancel-native.py','task-cancel-authority.mjs','task-cancel-program.py')and sha(HERE/name)==digest,'source differs')
    need(len(pins['scripts'])==3,'closed source manifest required')
    consumer=Path(pins['hands']);need(consumer.is_relative_to('/nix/store')and consumer.resolve()==consumer,'immutable consumer required')
    for name,digest in pins['consumerModules'].items():need(name.endswith('.py')and '/'not in name and sha(consumer/name)==digest,'consumer differs')
    need(set(pins['tools'])=={'python','node','systemctl','flock','systemd-run','taskset'},'closed runtime tools required')
    for name in ('python','node','systemctl','flock','systemd-run','taskset'):

        path=Path(pins['tools'][name]);need(path.resolve()==path and path.is_relative_to('/nix/store')and sha(path)==pins['toolSHA256'][name],'immutable tool differs')
    need('REVERIE_LEASE_LIB'not in os.environ,'external lease implementation refused')
    source=HERE.parents[1]
    required={'python/reverie/__init__.py','python/reverie/workspaces.py','python/reverie/lease.py','python/reverie/cleanup/lease.py'}
    need(set(pins['leaseFiles'])==required,'fixed canonical lease closure required')
    for name,digest in pins['leaseFiles'].items():need(sha(source/name)==digest,'canonical lease source differs')
    scope=current_scope(pins);verify_outer(args,pins,task,scope)
    need(not(task/'TASK-CANCEL-ATTEMPT.json').exists(),'prior native task attempt; no replay')
    token=uuid.uuid4().hex;root=task/('cancel-fixture-'+token)
    exclusive(task/'TASK-CANCEL-ATTEMPT.json',{'scope':scope,'pinsSHA256':args.pins_sha256,'root':str(root),'at':time.time(),'workerTaskAcceptance':False})
    root.mkdir(mode=0o700)
    for directory in ('home','instance','tasks','tasks/heartbeat'):(root/directory).mkdir(mode=0o700)
    deadline=time.monotonic()+90
    environment={'HOME':str(root/'home'),'PATH':':'.join(dict.fromkeys(str(Path(p).parent)for p in pins['tools'].values())),'LANG':'C.UTF-8',
                 'REVERIE_DATA_DIR':str(root/'instance'),'REVERIE_ADMIN_PHONE_WAKE':'enabled','REVERIE_OWNER_CODING_EVIDENCE':'enabled'}
    # No production credential, instance, config or skill environment is inherited.
    os.environ.clear();os.environ.update(environment);os.chdir(root)
    bridge=None;manager=None;provider=None;thread=None;records=[];result={'state':'UNKNOWN_NO_REPLAY'};durable_result=False
    try:
        command=[pins['tools']['node'],str(HERE/'task-cancel-authority.mjs'),'--owned-fixture','--root',str(root),'--pins',str(pinpath),'--pins-sha256',args.pins_sha256]
        bridge=AuthorityBridge(command,environment,root,deadline);chat=CanonicalChat(bridge);binding=chat.binding;room=binding['roomId']
        provider=http.server.HTTPServer(('127.0.0.1',0),LocalProvider);thread=threading.Thread(target=provider.serve_forever,daemon=True);thread.start()
        sys.path.insert(0,str(consumer));import agent_loop as loop
        from coding_manager import TaskManager
        schema=root/'tools.json';exclusive(schema,{'version':1,'args_cap':24000,'result_cap':24000,'tools':[{'type':'function','function':{'name':'run_tests','parameters':{'type':'object','additionalProperties':False}}}]})
        coding={'root':str(root/'tasks'),'runner_argv':[pins['tools']['python'],'-I','-B',str(HERE/'task-cancel-program.py')],
                'tool_schema_file':str(schema),'profiles':{'drill':{'seconds':45,'operation_seconds':30}},
                'tasks':{TASK:{'rooms':[room],'delegate_sessions':[]}}}
        cfg=dict(loop.DEFAULTS,rooms=[room],dm_rooms=[],self_session_id=binding['sessionId'],self_name='Cancellation fixture',
                 state_file=str(root/'state.json'),api_base='http://127.0.0.1:'+str(provider.server_port)+'/v1',model='fixture-only',
                 prompt_cap_chars=120000,model_timeout_s=5,coding=coding,cli=['unused-fixed-bridge'],memory_instance=None,phone_wake=True)
        configpath=root/'settings.json';exclusive(configpath,{'coding':coding});cfg['_config_path']=str(configpath)
        state={room:{'seen':[],'claims':{},'since':0}};manager=TaskManager(loop,cfg,chat);cfg['_coding_manager']=manager
        status_model=lambda *_,**kw:{'content':'Fixture status only.'}
        for text in ('Status only; no work requested.','> /code heartbeat stale quoted request'):
            bridge.call('owner-post',room,text=text);loop.tick(cfg,chat,state,model=status_model)
            need(manager.active is None and not state.get('_coding'),'status/quote started task')
        unauthorized=bridge.call('anonymous-post',room,text='/code heartbeat unauthorized')
        need(unauthorized['status']in(401,403),'anonymous accepted')
        source=bridge.call('owner-post',room,text='/code heartbeat Start the fixed bounded heartbeat probe.')['message']
        need(source['from'].get('authenticatedOwner')is True and source['phoneWake']is True,'actual canonical owner/phone required')
        loop.tick(cfg,chat,state,model=status_model);need(manager.active is not None,'task not queued')
        target=root/'tasks/heartbeat';start_deadline=min(deadline-35,time.monotonic()+20)
        while time.monotonic()<start_deadline and not(target/'heartbeat.jsonl').exists():manager.pump();time.sleep(.01)
        need((target/'heartbeat.jsonl').exists(),'real heartbeat did not start');need(manager.active['runner']is not None,'real runner absent')
        runner=identity(manager.active['runner'].process.pid);need(runner is not None,'runner identity unavailable')
        records=[json.loads(p.read_bytes())for p in target.glob('*.json')]
        need(len(records)==2 and len({r['pid']for r in records})==2 and all(live(r)for r in records)and any(r['pid']==runner['pid']and r['startTick']==runner['startTick']for r in records),'real runner and descendant bindings required')
        need({r.get('kind')for r in records}=={'runner','heartbeat'},'fixed program roles required')
        for record in records:
            need(record['scriptSHA256']==sha(HERE/'task-cancel-program.py')and record['exe']==pins['tools']['python'],'fixed program/executable differs')
            need(record['cwd']==str(target if record['kind']=='heartbeat'else root),'fixed program cwd differs')
            need(str((Path('/proc')/str(record['pid'])/'exe').resolve())==record['exe']and str((Path('/proc')/str(record['pid'])/'cwd').resolve())==record['cwd']and os.getpgid(record['pid'])==runner['pid'],'actual program binding differs')
        before=(target/'heartbeat.jsonl').stat().st_size
        bridge.call('owner-post',room,text='/code-cancel other');loop.tick(cfg,chat,state,model=status_model)
        bridge.call('owner-post',binding['foreignRoomId'],text='/code-cancel heartbeat');loop.tick(cfg,chat,state,model=status_model)
        need(manager.active is not None and all(live(r)for r in records),'foreign cancellation affected task')
        time.sleep(.15);need((target/'heartbeat.jsonl').stat().st_size>before,'heartbeat not live before cancel')
        cancelled_at=time.monotonic();bridge.call('owner-post',room,text='/code-cancel heartbeat');loop.tick(cfg,chat,state,model=status_model)
        need(manager.active is None,'cancel did not close exact active task')
        cleanup_deadline=min(deadline-5,cancelled_at+30)
        while any(live(r)for r in records)and time.monotonic()<cleanup_deadline:time.sleep(.02)
        need(not any(live(r)for r in records),'owned task process remains')
        try:os.killpg(runner['pid'],0)
        except ProcessLookupError:pass
        else:raise RuntimeError('owned task group remains')
        settled_at=time.monotonic()
        row=state['_coding'][room+':'+source['id']];need(row['status']=='stopped'and row['reason']=='cancelled','durable task did not record cancellation')
        original=copy.deepcopy(state['_coding']);bridge.call('owner-post',room,text='/code-cancel heartbeat');loop.tick(cfg,chat,state,model=status_model)
        need(state['_coding']==original and manager.active is None,'duplicate cancel changed task journal')
        snapshots={str(p.relative_to(root)):sha(p)for p in [root/'state.json',*target.iterdir()]if p.is_file()}
        observation=time.monotonic()+5;need(observation<deadline,'no observation budget')
        while time.monotonic()<observation:manager.pump();time.sleep(.05)
        need(all(sha(root/n)==digest for n,digest in snapshots.items()),'late task write')
        need(LocalProvider.calls==1 and not any(live(r)for r in records),'late task/model effect')
        result={'state':'PASS_OWN_CANONICAL_CANCEL_COMPONENT','physicalBindings':records,'canonicalSourceId':source['id'],
                'roomId':room,'taskId':TASK,'cancelSeconds':settled_at-cancelled_at,'noLateEffectsObservedSeconds':5,
                'modelRequests':LocalProvider.calls,'logicalPollingFixture':True,'nativeAgentAuthentication':'NOT_EXERCISED',
                'productionTaskOrGrantEffects':False}
    finally:
        cleanup=[]
        try:
            if manager is not None and manager.active is not None:manager.finish({'status':'stopped','reason':'fixture_cleanup'},post=False)
        except BaseException as error:cleanup.append({'target':'task','class':type(error).__name__})
        try:
            if provider is not None:provider.shutdown();provider.server_close()
            if thread is not None:
                remaining=min(1,deadline-time.monotonic());need(remaining>0,'provider cleanup deadline');thread.join(timeout=remaining)
                need(not thread.is_alive(),'provider thread remains')
        except BaseException as error:cleanup.append({'target':'provider','class':type(error).__name__})
        try:
            if bridge is not None:bridge.close()
        except BaseException as error:cleanup.append({'target':'authority','class':type(error).__name__})
        if cleanup or any(live(r)for r in records):result={'state':'UNKNOWN_NO_REPLAY','cleanup':cleanup,'knownTaskSurvivors':[r for r in records if live(r)]}
        exclusive(root/'RESULT.json',result)
        durable_result=True
    need(durable_result and result['state']=='PASS_OWN_CANONICAL_CANCEL_COMPONENT','no pass; preserve unknown attempt')


if __name__=='__main__':main()
