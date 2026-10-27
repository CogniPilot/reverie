"""Installed ordinary-owner OPS daemon. No activation or engine effects at import."""
import argparse,fcntl,hashlib,os,signal,stat,sys,threading
from pathlib import Path
from .ops_common import *
from .ops_core import Core,Ledger
from .ops_adapter import Engine,DockerWebsite
from .ops_classifier import WorkerClassifier
from .ops_auth import UnavailableAuth,ServiceDecisionsAuth
from .ops_transport import Client,Server
from .worker_storage import read_metadata

class Custody:
 """Validate every configured and actual live/stopped worker mount before key use/effects."""
 def __init__(self,config,engine,source_path=None):self.config=config;self.engine=engine;self.source_path=source_path;self.lock=threading.RLock()
 def __call__(self):
  with self.lock:
   cfg=self.config
   if self.source_path is not None:require(digest(load_configuration(self.source_path))==digest(cfg),'custody-invalid')
   broker=read_metadata(cfg['brokerConfig'],os.getuid());mounts=[m['source'] for m in broker['mounts']]+[broker['scratchRoot'],str(Path(broker['stateRoot'])/'employees'),str(Path(broker['companyRoot'])/'console/accounts')]
   code,out,_=self.engine.run(['ps','-a','-q','--no-trunc','--filter','label=reverie.worker='+broker['deployment']]);require(code==0,'custody-invalid');ids=out.decode().split();require(len(ids)<=256 and all(len(i)==64 and all(c in '0123456789abcdef' for c in i) for i in ids),'custody-invalid')
   if ids:
    code,out,_=self.engine.run(['inspect','--type','container',*ids],limit=4*1024*1024);require(code==0,'custody-invalid');rows=strict_json(out);require(len(rows)==len(ids),'custody-invalid')
    for row in rows:
     require(row['Id'] in ids and row['Config']['Labels'].get('reverie.worker')==broker['deployment'],'custody-invalid')
     mounts.extend(m['Source'] for m in row.get('Mounts',[]) if isinstance(m.get('Source'),str) and m['Source'].startswith('/'))
   if self.source_path is not None:outside_mounts(self.source_path,mounts)
   for field in ('stateDirectory','socketDirectory','requestKey'):
    outside_mounts(cfg[field],mounts)
   if cfg['authorization'] is not None:
    outside_mounts(cfg['authorization']['config'],mounts)
    auth_config=strict_json(private_read(cfg['authorization']['config'],65536))
    for principal in auth_config['principals']:outside_mounts(principal['key'],mounts)
    goal_path=cfg['authorization'].get('goalPrivateConfig');require(goal_path,'adapter-unavailable');outside_mounts(goal_path,mounts);goal=strict_json(private_read(goal_path,65536))
    for binding in goal['paths'].values():outside_mounts(binding['host'],mounts)
   # Future grants and this read/effect must share the same broker custody lock in integration.
   return broker

def load_configuration(path):
 cfg=strict_json(private_read(path,65536));shape(cfg,('version','companyId','companyFile','brokerConfig','stateDirectory','socketDirectory','requestKey','engineBinary','engineSocket','engineConfigDirectory','resources','authorization','packageManifest'))
 require(type(cfg['version']) is int and cfg['version']==1);identifier(cfg['companyId']);require(isinstance(cfg['resources'],dict) and 1<=len(cfg['resources'])<=16)
 for rid in cfg['resources']:identifier(rid)
 for field in ('companyFile','brokerConfig','stateDirectory','socketDirectory','requestKey','engineBinary','engineSocket','engineConfigDirectory','packageManifest'):require(Path(cfg[field]).is_absolute(),'custody-invalid')
 return cfg

def make_service(path):
 cfg=load_configuration(path);private_directory(cfg['stateDirectory']);private_directory(cfg['socketDirectory']);private_directory(cfg['engineConfigDirectory'])
 # A running source checkout cannot masquerade as an installed immutable executor.
 installation=strict_json(private_read(Path(cfg['stateDirectory'])/'installation.json',65536));manifest=strict_json(Path(cfg['packageManifest']).read_bytes())
 require(installation['packageDigest']==digest(manifest) and installation['configDigest']==digest(cfg),'not-installed')
 for name,expected in manifest['sources'].items():
  require('/' not in name and name.endswith('.py'),'custody-invalid');source=Path(__file__).parent/name;info=source.stat();require(info.st_uid in (0,os.getuid()) and not info.st_mode&0o022 and hashlib.sha256(source.read_bytes()).hexdigest()==expected,'not-installed')
 engine=Engine(cfg['engineBinary'],cfg['engineSocket'],cfg['engineConfigDirectory']);custody=Custody(cfg,engine,path);custody()
 key=private_read(cfg['requestKey'],32);require(len(key)==32,'custody-invalid')
 auth=UnavailableAuth()
 if cfg['authorization'] is not None:
  auth=ServiceDecisionsAuth(cfg['authorization'],cfg['companyFile'],cfg['companyId'],os.getuid(),custody)
 classifier=WorkerClassifier(strict_json((Path(__file__).parent/'ops-classifier-pin.json').read_bytes()),manifest['systemctlExecutable'],cfg['brokerConfig'])
 ledger=Ledger(cfg['stateDirectory']);resources={rid:DockerWebsite(value,engine,cfg['companyFile'],os.getuid(),custody=custody,classifier=classifier,service_binding=digest({'manifest':manifest,'configuration':cfg})) for rid,value in cfg['resources'].items()}
 core=Core(ledger,cfg['companyFile'],cfg['companyId'],resources,auth);core.recover()
 return cfg,Server(Path(cfg['socketDirectory'])/'ops.sock',key,ledger,core,custody=custody)

def phone_client(config):
 """Only the host broker reads this config/key. Its fixed OfficeAPI supplies SID."""
 cfg=load_configuration(config);engine=Engine(cfg['engineBinary'],cfg['engineSocket'],cfg['engineConfigDirectory']);Custody(cfg,engine,config)();key=private_read(cfg['requestKey'],32);require(len(key)==32,'custody-invalid')
 return Client(Path(cfg['socketDirectory'])/'ops.sock',key)

def main(argv=None):
 parser=argparse.ArgumentParser(description=__doc__,allow_abbrev=False);parser.add_argument('--config',required=True);args=parser.parse_args(argv)
 try:
  require(sys.platform=='linux' and os.geteuid()!=0,'unsupported-platform');cfg=load_configuration(args.config);directory=private_directory(cfg['stateDirectory']);fd=os.open(directory/'daemon.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  # An existing socket is removed only when its recorded PID is dead; never steal a live transport.
  sock=Path(cfg['socketDirectory'])/'ops.sock'
  if sock.exists():
   require(sock.is_socket(),'custody-invalid')
   import socket
   with socket.socket(socket.AF_UNIX) as probe:
    try:probe.connect(str(sock))
    except ConnectionRefusedError:sock.unlink()
    else:raise Refusal('resource-busy')
  _,server=make_service(args.config)
  def stop(*_):threading.Thread(target=server.server.shutdown,daemon=True).start()
  signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
  try:server.serve_forever()
  finally:server.server.server_close();server.path.unlink(missing_ok=True);os.close(fd)
  return 0
 except (Refusal,OSError,ValueError,KeyError,TypeError):print('OPS unavailable: installation, private custody, adapter or authority binding requires verification.',file=sys.stderr);return 1

def broker_binding_custody(broker):
 """Validate optional host-only binding before accepting a broker configuration.

Configured account roots cover future account mount selections. Mount/resource
reload cannot introduce a different binding silently. No new grant is created.
"""
 cfg=load_configuration(broker['opsConfig'])
 require(cfg['companyFile']==broker['companyFile'] and cfg['brokerConfig'] is not None,'custody-invalid')
 mounts=[m['source'] for m in broker['mounts']]+[broker['scratchRoot'],str(Path(broker['stateRoot'])/'employees'),str(Path(broker['companyRoot'])/'console/accounts')]
 outside_mounts(broker['opsConfig'],mounts)
 for key in ('stateDirectory','socketDirectory','requestKey'):outside_mounts(cfg[key],mounts)
 if cfg['authorization'] is not None:
  outside_mounts(cfg['authorization']['config'],mounts)
  auth_config=strict_json(private_read(cfg['authorization']['config'],65536))
  for principal in auth_config['principals']:outside_mounts(principal['key'],mounts)
  goal_path=cfg['authorization'].get('goalPrivateConfig');require(goal_path,'adapter-unavailable');outside_mounts(goal_path,mounts);goal=strict_json(private_read(goal_path,65536))
  for binding in goal['paths'].values():outside_mounts(binding['host'],mounts)

if __name__=='__main__':raise SystemExit(main())
