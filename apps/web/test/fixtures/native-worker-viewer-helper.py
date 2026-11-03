"""Owned real tmux/worker frames with deterministic provider and metadata-only engine adapter."""
import json,os,shlex,shutil,signal,socket,subprocess,sys,threading,time
from pathlib import Path
sys.path.insert(0,str(Path(os.environ['FIXTURE_SOURCE_ROOT'])/'python'))
from reverie.worker import Broker
from reverie.worker_resources import policy_digest
import reverie.worker as W
original_send=W.send_frame
def traced_send(connection,kind,payload):
 if kind==b'E':print('BROKER_ERROR',payload.decode(errors='replace'),flush=True)
 return original_send(connection,kind,payload)
W.send_frame=traced_send
root=Path(os.environ['FIXTURE_ROOT']);sid=os.environ['FIXTURE_SID'];tmux=os.environ['FIXTURE_TMUX'];inner=root/'inner.sock';stop=threading.Event();threads=[]
def native(*args):return subprocess.run([tmux,'-u','-S',str(inner),*args],check=True,capture_output=True,text=True,timeout=5).stdout.strip()
for p in [root/'control',root/'workers'/sid/'home'/'.reverie-launch',root/'work',root/'company',root/'scratch',root/'office']:p.mkdir(mode=0o700,parents=True,exist_ok=True)
for p in [root/'workers',root/'workers'/sid,root/'workers'/sid/'home']:p.chmod(0o700)
(root/'company.json').write_text(json.dumps({'employees':[]}));(root/'company.json').chmod(0o600)
(root/'workers'/sid/'runtime.json').write_text(json.dumps({'exit':'fixture.exit'}))
provider=root/'provider.py'
shutil.copyfile(Path(__file__).with_name('native-worker-viewer-provider.py'), provider)
native('-f','/dev/null','new-session','-d','-x','160','-y','40','-s','office','exec '+shlex.join([sys.executable,'-I','-B',str(provider),str(root)]))
native('set-option','-t','office','remain-on-exit','on')
provider_pid=int(native('display-message','-p','-t','office','#{pane_pid}'))
engine=root/'only-owned-engine'
engine.write_text('#!'+sys.executable+'\nimport os,sys\na=sys.argv[1:];i=a.index("/bin/tmux");tail=a[i+1:];assert tail[:3]==["-u","-L","reverie-laptop"];assert tail[3:] == ["attach-session","-d","-t","office"];os.execv('+repr(tmux)+',["tmux","-u","-S",'+repr(str(inner))+']+tail[3:])\n');engine.chmod(0o700)
config=dict(version=1,deployment='fixture',image='sha256:'+'a'*64,serverContainer='fixture-console',socket=str(root/'control/broker.sock'),stateRoot=str(root/'workers'),companyFile=str(root/'company.json'),companyRoot=str(root/'company'),scratchRoot=str(root/'scratch'),apiSocketRoot=str(root/'office'),budgetMode='admission',uid=os.getuid(),gid=os.getgid(),memoryMiB=4096,poolMemoryMiB=4096,poolTasksMax=1024,cgroupParent='reverie-workers.slice',pidsLimit=128,cpus=0,maxWorkers=4,maintenanceSessions=[],mounts=[dict(source=str(root/'work'),destination=str(root/'work'),readOnly=False)])
broker=Broker(config);broker.engine=str(engine);broker.office=lambda _sid:None
calls=root/'adapter-calls.jsonl'
def engine_metadata(args,optional=False,**kwargs):
 with calls.open('a')as f:f.write(json.dumps(args)+'\n')
 if args[0]=='inspect':value=json.dumps([{'Config':{'Labels':{'reverie.worker':'fixture','reverie.session':sid,'reverie.worker-policy':policy_digest(config,sid)}},'State':{'Running':True}}])
 elif args[0]=='exec':value=native('display-message','-p','-t','office','#{pane_dead}')
 else:raise AssertionError('Forbidden engine command '+args[0])
 return subprocess.CompletedProcess(args,0,value,'')
broker.run_engine=engine_metadata
server=socket.socket(socket.AF_UNIX);server.bind(config['socket']);os.chmod(config['socket'],0o600);server.listen();server.settimeout(.2)
def done(*_):stop.set();broker.stopping.set()
signal.signal(signal.SIGTERM,done);signal.signal(signal.SIGINT,done)
(root/'helper-ready.json').write_text(json.dumps({'provider_pid':provider_pid,'inner_server_pid':int(native('display-message','-p','-t','office','#{pid}')),'provider_start_tick':Path('/proc',str(provider_pid),'stat').read_text().rsplit(')',1)[1].split()[19],'inner_socket':str(inner),'broker_socket':config['socket']}))
try:
 while not stop.is_set():
  try:connection,_=server.accept()
  except socket.timeout:continue
  broker.connections.acquire();thread=threading.Thread(target=broker.handle,args=(connection,));thread.start();threads.append(thread)
finally:
 server.close();broker.stopping.set()
 for thread in threads:thread.join(5)
 subprocess.run([tmux,'-S',str(inner),'kill-server'],capture_output=True)
 for sid in list(broker.storage_leases):broker.release_storage(sid)
 (root/'helper-settled.json').write_text(json.dumps({'threads_settled':all(not t.is_alive() for t in threads),'metadata_only_adapter':True,'real_authenticated_provider':False}))
