#!/usr/bin/env python3
"""Owned H producer/listener/bootstrap/PTY acceptance. No production instance input.

The foreground fixed-service/website metadata ports are deliberately controlled.
Installation parsing/immutable toolkit, H serve/Handoff/ledger and guest PTY
monitor/ancestry/settlement stay real. Never installs a systemd unit.
"""
import argparse,base64,fcntl,hashlib,json,os,re,select,socket,stat,subprocess,sys,time,uuid
from pathlib import Path
from types import SimpleNamespace

def write(path,value):
    raw=value if isinstance(value,bytes) else (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC,0o600)
    with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
def changed(path,value):
    temp=Path(str(path)+'.next');write(temp,value);os.replace(temp,path)
def docker(client,*args):
    environment={'PATH':str(Path(client[0]).parent),'HOME':client[-1], 'LANG':'C.UTF-8'}
    return subprocess.check_output([*client,*args],env=environment,text=True,stderr=subprocess.PIPE).strip()
def inspect(engine,cid):return json.loads(docker(engine,'inspect',cid))[0]
def modules(source):
    sys.path.insert(0,str(Path(source)/'python'))
    from reverie import owner_terminal_lifecycle as L,owner_terminal_native as N,owner_terminal_channel as C
    from reverie import owner_terminal_host as H,owner_terminal_pty as PT,owner_terminal_toolkit as T
    return L,N,C,H,PT,T

def ports(config_path,source):
    L,N,C,H,PT,T=modules(source)
    def cfg():return json.loads(Path(config_path).read_text())
    class OwnedEngine:
        def __init__(self,*unused):self.path=cfg()['engineSocket']
        def guard(self):
            value=cfg();row=self.get('/containers/'+value['workerCID']+'/json')
            assert row['Id']==value['workerCID'] and row['Image']==value['workerImage']
            assert row['Config']['Labels'].get('reverie.fixture')==value['fixtureId']
        def get(self,route):
            value=cfg();assert route=='/containers/'+value['workerCID']+'/json',route
            # Same bounded local HTTP metadata interface as the native runtime;
            # spawning a Docker CLI for every observation exhausts its real
            # five-second operation budget and is not a faithful fixture port.
            import http.client
            connection=http.client.HTTPConnection('localhost',timeout=2)
            connection.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            connection.sock.settimeout(2);connection.sock.connect(self.path)
            try:
                connection.request('GET',route);response=connection.getresponse();raw=response.read((8<<20)+1)
                assert response.status==200 and len(raw)<=8<<20
                row=json.loads(raw);assert row['Id']==value['workerCID'];return row
            finally:connection.close()
    class WebsiteMetadata:
        def __init__(self,engine,selection):self.engine=engine;self.selection=selection
        def bind_once(self):
            value=cfg();process=C.read_proc(value['bootstrapPID'])
            return {'containerId':value['websiteCID'],'initPid':process['pid'],'initStart':process['start']}
    N.Engine=OwnedEngine;N.WebsiteFacts=WebsiteMetadata
    # Explicit TEST-ONLY metadata observation port: no general engine inventory,
    # real broker, production grants or service manager are read by this fixture.
    def native_guard(self,config):self.engine.guard()
    N.Installation._guard_native=native_guard
    def website(self):
        self.guard();return {'Id':cfg()['websiteCID'],'fixtureWebsiteMetadata':True}
    N.Installation.assert_website=website
    def observe(self,eid):
        value=cfg();self.guard();assert eid==value['employeeId']
        company=json.loads(Path(self.config['companyFile']).read_text())
        assert company['employees']==[value['employee']]
        row=self.engine.get('/containers/'+value['workerCID']+'/json')
        initial=C.read_proc(row['State']['Pid']);signature=N.target_signature(row)
        key=(row['Id'],signature,C.digest(initial))
        if key not in self.toolkit_cache:
            assert T.qualify(row,self.toolkit,uid=os.getuid(),gid=os.getgid())==initial
            storage=T.StorageRootCustody(initial,{'home':value['home'],'nix':value['nix']})
            self.toolkit_cache[key]={'init':initial,'signature':signature,'storage':storage}
        self.toolkit_cache[key]['storage'].assert_current()
        self.assert_human_binding({'containerId':row['Id'],'init':initial,'signature':signature,
                                   'roots':self.toolkit_cache[key]['storage'].snapshot()})
        return dict(value['target'])
    N.Installation.observe=observe
    class WebsitePeer(C.WebsitePeer):
        def __init__(self,installation):object.__setattr__(self,'installation',installation)
        def assert_process(self,credentials,stage):
            value=cfg();assert credentials==(value['bootstrapPID'],os.getuid(),os.getgid())
            actual=C.read_proc(credentials[0]);assert actual['start']==value['bootstrapStart']
            program=value['bootstrapProgram'] if stage=='bootstrap' else value['nodeProgram']
            C.Program(program['executable'],tuple(program['argv'])).matches(actual)
            return actual
    H.ProtectedWebsitePeer=WebsitePeer
    class ForegroundTerminal(PT.HumanTerminal):
        def open(self,*args,**kwargs):
            try:return super().open(*args,**kwargs)
            except BaseException:
                __import__('traceback').print_exc()
                for key,record in self.sessions.items():
                    print('FIXTURE_OPEN_DIAGNOSTIC',json.dumps({'shell':key,'clientStatus':record['child'].poll(),
                          'prepared':record['prepared'],'ready':record['ready'],'bufferBytes':len(record['buffer'])}),file=sys.stderr,flush=True)
                raise
        def __init__(self,installation,engine_program,channel):
            # Explicit TEST-ONLY replacement of fixed production unit/cgroup
            # admission. The exact fixture foreground process and real channel
            # are pinned; no fabricated production service qualification.
            self.installation,self.engine=installation,engine_program
            self.sessions={};self.unknown=set();self.settlements={}
            self.process=C.read_proc(os.getpid())
            self.program=C.Program(str(Path('/proc/self/exe').resolve()),tuple(cfg()['hostArgv']))
            self.program.matches(self.process);self.digest=hashlib.sha256(PT.protocol.canonical(self.process)).hexdigest()
            self.peer_channel=channel;info=os.fstat(channel.node.fileno());self.peer_descriptor=(info.st_dev,info.st_ino)
            info=installation.roots['ledgerRoot'].stat();self.root_identity=(info.st_dev,info.st_ino,info.st_uid,stat.S_IMODE(info.st_mode))
        def assert_current_peer(self,digest):
            assert digest==self.digest and C.read_proc(os.getpid())==self.process
            self.program.matches(self.process);channel=self.peer_channel
            assert channel.state=='CONNECTED' and not select.select([channel.pidfd],[],[],0)[0]
            info=os.fstat(channel.node.fileno());assert (info.st_dev,info.st_ino)==self.peer_descriptor
            assert fcntl.fcntl(channel.node.fileno(),fcntl.F_GETFD)&fcntl.FD_CLOEXEC
            credentials=tuple(__import__('struct').unpack('3i',channel.node.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12)))
            assert credentials==channel.credentials
            channel.website.assert_process(credentials,'node');self.installation.guard()
    H.HumanTerminal=ForegroundTerminal
    return L,N,C,H,PT,T

def produce(config_path,source,runtime_path):
    L,N,C,H,PT,T=ports(config_path,source);value=json.loads(Path(config_path).read_text());root=Path(value['controlBase']).parent
    runtime_raw=Path(runtime_path).read_bytes()
    runtime=L.RuntimeManifest({'path':runtime_path,'sha256':hashlib.sha256(runtime_raw).hexdigest()})
    initial=L.InitialInstallation.__new__(L.InitialInstallation)
    initial.path=Path(value['controlBase'])/'initial.json'
    initial.roots={name:Path(value[name]) for name in ('controlBase','ledgerBase','bootstrapRoot')}
    initial.root_ids={name:L._directory_identity(path) for name,path in initial.roots.items()}
    initial.lock_path=root/'maintenance.lock';write(initial.lock_path,b'')
    initial.deployment_path=root/'deployment.json'
    initial.value={'workerConfig':value['workerConfig'],'entitlements':[value['employeeId']],
                   'engine':{'socket':value['engineSocket'],'identity':[0,0,0,0],'id':'synthetic metadata port'},
                   'externalOrigin':'http://fixture.invalid','ingressPeers':[{'address':'127.0.0.1','localPort':3000,'encrypted':False}]}
    write(initial.path,L._encoded(initial.value));initial.identity=L.private_document(initial.path)[1]
    write(initial.deployment_path,{'websiteRuntime':'terminal','ownerTerminalConfig':str(initial.path)})
    initial.runtime=runtime;initial.host_program=runtime.host_program;initial.engine_program=runtime.engine_program
    def guard():
        initial.worker_selection=L.private_bytes(value['workerConfig'])
        return json.loads(initial.worker_selection[0])
    initial.guard=guard
    initial.derive_policy=lambda cid,spec,config:{'containerId':cid,'initPid':None,'initStart':None}
    initial.unit_state=lambda:{'MainPID':'0','ActiveState':'inactive'}
    initial.unit_text=lambda:b'TEST ONLY foreground fixture; no production or manager unit published\n'
    initial.install_unit=lambda raw,old:write(root/'unit-port.txt',raw)
    spec=root/'approved-spec.json';write(spec,{'Image':value['workerImage'],'fixture':'metadata only synthetic website'})
    fd=os.open(initial.lock_path,os.O_RDWR|os.O_CLOEXEC)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX)
        record=initial.prepare_created(fd,value['websiteCID'],spec,hashlib.sha256(spec.read_bytes()).hexdigest())
    finally:os.close(fd)
    policy=json.loads(Path(record['policyPath']).read_text())
    assert policy['toolkitManifest']==runtime.value['toolkitManifest']
    actual=N.Installation(Path(record['policyPath']),record['policySHA256'])
    try:assert actual.toolkit==T.immutable_manifest(runtime.value['toolkitManifest'])
    finally:actual.close()
    return record,runtime

def serve(config_path,source):
    value=json.loads(Path(config_path).read_text());*_,H,PT,T=ports(config_path,source)
    H.serve(value['policyPath'])

def bootstrap(config_path,source):
    value=json.loads(Path(config_path).read_text())
    deadline=time.monotonic()+15
    while not Path(value['bootstrapGo']).exists():
        if time.monotonic()>deadline:raise RuntimeError('fixture bootstrap go missing')
        time.sleep(.01)
    modules(source)
    from reverie import owner_terminal_bootstrap as B
    B.PATH=value['bootstrapSocket']
    B.exec_backend(value['nodeProgram']['executable'],tuple(value['nodeProgram']['argv']))

def run(args):
    # Qualify the selected immutable runtime and its bound Docker ELF before
    # creating any container. There is no host PATH or machine-specific fallback.
    L,*_=modules(args.native_source)
    runtime_raw=Path(args.runtime_manifest).read_bytes()
    runtime=L.RuntimeManifest({'path':args.runtime_manifest,'sha256':hashlib.sha256(runtime_raw).hexdigest()})
    engine=str(runtime.engine_program)
    endpoint=Path(args.engine_socket)
    assert endpoint.is_absolute() and endpoint.resolve(strict=True)==endpoint and stat.S_ISSOCK(endpoint.stat().st_mode)
    root=Path(args.evidence).resolve();root.mkdir(mode=0o700,parents=True,exist_ok=False)
    task=Path(args.work).resolve();fixture=str(uuid.uuid4());host=node=None;cid=None;settled=False
    client_config=task/'engine-config';client_config.mkdir(mode=0o700)
    client=[engine,'--host','unix://'+str(endpoint),'--config',str(client_config)]
    local=json.loads(docker(client,'image','inspect',args.worker_image))[0]
    assert local['Id']==args.worker_image
    for name in ('control','ledger','bootstrap'):(root/name).mkdir(mode=0o700)
    home=task/'home';nix=task/'nix';home.mkdir(mode=0o700);nix.mkdir(mode=0o700)
    eid,sid=str(uuid.uuid4()),str(uuid.uuid4())
    employee={'id':eid,'sessionId':sid,'sessionGeneration':1,'desiredRunning':True,'onVacation':False,'bindingMigration':None}
    company=root/'company.json';write(company,{'employees':[employee]})
    worker=root/'worker.json';write(worker,{'uid':os.getuid(),'gid':os.getgid(),'companyFile':str(company)})
    config_path=root/'fixture.json';script=str(Path(__file__).resolve())
    try:
        cmd=['create','--pull','never','--name','reverie-h-fixture-'+fixture,'--label','reverie.fixture='+fixture,
             '--network','none','--user',str(os.getuid())+':'+str(os.getgid()),'--read-only','--cap-drop','ALL',
             '--security-opt','no-new-privileges','--memory','256m','--memory-swap','256m','--pids-limit','64',
             '--mount','type=bind,src='+str(home)+',dst=/home/agent','--mount','type=bind,src='+str(nix)+',dst=/nix',
             '--tmpfs','/tmp:rw,nosuid,nodev,size=16m','-i','--entrypoint','/opt/reverie/human/bin/bash',args.worker_image,
             '--noprofile','--norc','-c',"trap 'exit 0' TERM INT HUP; while read -r unused; do :; done"]
        cid=docker(client,*cmd);assert len(cid)==64
        write(root/'created-container.json',{'id':cid,'image':args.worker_image,'fixtureId':fixture,'bindSources':[str(home),str(nix)]})
        docker(client,'start',cid);row=inspect(client,cid);assert row['State']['Running']
        target={'employeeId':eid,'sessionId':sid,'sessionGeneration':1,'containerId':cid,'imageId':args.worker_image,
                'policyDigest':hashlib.sha256((fixture+cid).encode()).hexdigest(),'running':True,
                'onVacation':False,'desiredRunning':True,'humanTerminalEntitled':True}
        cfg={'fixtureId':fixture,'workerCID':cid,'workerImage':args.worker_image,'websiteCID':'e'*64,'employeeId':eid,'employee':employee,'target':target,
             'home':str(home),'nix':str(nix),'workerConfig':str(worker),'engineSocket':str(endpoint),
             'controlBase':str(root/'control'),'ledgerBase':str(root/'ledger'),'bootstrapRoot':str(root/'bootstrap'),
             'bootstrapSocket':str(root/'bootstrap/bootstrap.sock'),'bootstrapGo':str(root/'bootstrap-go'),
             'handle':str(uuid.uuid4()),'token':uuid.uuid4().hex}
        write(config_path,cfg)
        record,runtime=produce(config_path,args.native_source,args.runtime_manifest)
        write(root/'producer-consumer.json',{'state':'REAL_PRODUCER_REAL_CONSUMER_PASS','record':record,
                    'toolkitManifest':runtime.value['toolkitManifest'],'nativeSource':args.native_source})
        cfg['policyPath']=record['policyPath']
        # DO NOT create the producer's missing engine config here. Its absence
        # must fail actual HumanTerminal.open and expose the contract gap.
        invocation=runtime.host_program['argvPrefix'][0]
        host_args=[invocation,'-I','-B',script,'serve','--fixture',str(config_path),'--native-source',args.native_source]
        node_path=str(Path(args.node).resolve());node_args=[node_path,str(Path(script).with_name('owner-terminal-native-client.mjs')),str(config_path)]
        bootstrap_args=[invocation,'-I','-B',script,'bootstrap','--fixture',str(config_path),'--native-source',args.native_source]
        cfg.update(hostArgv=host_args,bootstrapProgram={'executable':runtime.host_program['executable'],'argv':bootstrap_args},
                   nodeProgram={'executable':node_path,'argv':node_args})
        changed(config_path,cfg)
        env={k:v for k,v in os.environ.items() if k in ('PATH','LANG')}
        env['HOME']=str(task)
        host_out=open(root/'host.stdout','wb');host_err=open(root/'host.stderr','wb')
        host=subprocess.Popen(host_args,stdout=host_out,stderr=host_err,env=env,start_new_session=True)
        deadline=time.monotonic()+15
        while not Path(cfg['bootstrapSocket']).exists():
            if host.poll() is not None:raise RuntimeError('fixture host ended before listener')
            if time.monotonic()>deadline:raise RuntimeError('fixture listener deadline')
            time.sleep(.02)
        node_out=open(root/'backend.stdout','wb');node_err=open(root/'backend.stderr','wb')
        node=subprocess.Popen(bootstrap_args,stdout=node_out,stderr=node_err,env=env,start_new_session=True)
        *_,C,H,PT,T=modules(args.native_source)
        cfg.update(bootstrapPID=node.pid,bootstrapStart=C.read_proc(node.pid)['start'])
        changed(config_path,cfg);write(Path(cfg['bootstrapGo']),b'GO\n')
        deadline=time.monotonic()+40
        while True:
            text=(root/'backend.stdout').read_text()
            if 'H_ISOLATED_PTY_ACCEPTANCE_PASS' in text:break
            if node.poll() is not None:raise RuntimeError('fixture backend ended without PTY proof')
            if host.poll() is not None:raise RuntimeError('fixture host ended during PTY')
            if time.monotonic()>deadline:raise RuntimeError('fixture PTY deadline')
            time.sleep(.05)
        host.terminate();assert host.wait(timeout=10)==0
        assert node.wait(timeout=10)==0
        for f in (host_out,host_err,node_out,node_err):f.close()
        control=Path(record['policyPath']).parent
        connected=json.loads((control/'HOST-CONNECTED.json').read_text())
        drained=json.loads((control/'HOST-DRAINED.json').read_text())
        assert drained['settlements'] and not Path(cfg['bootstrapSocket']).exists()
        result={'state':'PASS','producerConsumer':True,'actualListenerBootstrapExecNode':True,'actualStaticMonitorPTY':True,
                'positiveGuestAndClientSettlement':True,'connectedNodePID':connected['nodeProcess']['pid'],
                'testOnlyPorts':['engine website/broker/control inventory metadata','foreground fixed-service admission','synthetic backend owner authority'],
                'notExercised':['production systemd unit activation','real browser owner authentication','production instance or providers'],
                'workerCID':cid,'workerImage':args.worker_image,'engineProgram':engine,
                'nativeSource':args.native_source,'runtimeManifest':args.runtime_manifest}
        write(root/'RESULT.json',result);print(json.dumps(result),flush=True);settled=True
    finally:
        for child in (host,node):
            if child is not None and child.poll() is None:
                child.terminate()
                try:child.wait(timeout=10)
                except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
        if cid:
            row=inspect(client,cid)
            assert row['Config']['Labels'].get('reverie.fixture')==fixture and row['Image']==args.worker_image
            expected={str(home),str(nix)}
            assert {m['Source'] for m in row['Mounts'] if m['Type']=='bind'}==expected
            if row['State']['Running']:docker(client,'stop','--time','5',cid)
            docker(client,'rm',cid)
            write(root/'container-cleanup.json',{'exactOwnedCID':cid,'removed':True,'normalSettlementProved':settled})

def main():
    def image_id(value):
        if re.fullmatch(r'sha256:[a-f0-9]{64}',value) is None:
            raise argparse.ArgumentTypeError('Select an exact locally present sha256 image ID; tags are not accepted')
        return value
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=('run','serve','bootstrap'))
    parser.add_argument('--native-source',required=True);parser.add_argument('--fixture')
    parser.add_argument('--runtime-manifest');parser.add_argument('--evidence');parser.add_argument('--work');parser.add_argument('--node')
    parser.add_argument('--worker-image',type=image_id)
    parser.add_argument('--engine-socket',help='Canonical local Unix engine socket; no context or credential inheritance')
    args=parser.parse_args()
    if args.mode=='run' and not all((args.runtime_manifest,args.evidence,args.work,args.node,args.worker_image,args.engine_socket)):
        parser.error('run requires runtime-manifest, evidence, work, node, exact worker-image and engine-socket')
    if args.mode!='run' and not args.fixture:parser.error('serve/bootstrap require their private fixture input')
    if args.mode=='run':run(args)
    elif args.mode=='serve':serve(args.fixture,args.native_source)
    else:bootstrap(args.fixture,args.native_source)
if __name__=='__main__':main()
