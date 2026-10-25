"""One-time ordinary-owner OPS user-service installation. Never creates grants or starts effects."""
import argparse,hashlib,os,stat,subprocess,sys
from pathlib import Path
from .ops_common import *
from .ops_service import load_configuration,Custody
from .ops_adapter import Engine,DockerWebsite
UNIT='reverie-ops.service'

def atomic_private(path,data):
 path=Path(path);private_directory(path.parent,create=True)
 if path.exists():require(private_read(path,max(len(data),65536))==data,'custody-invalid');return False
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
 with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
 d=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(d);os.close(d);return True

def prepare_authority_state(cfg,allow_initialize=True):
 """Reference Ada r2d's existing canonical Goal projection; never manufacture a nonce/bootstrap stand-in."""
 if cfg['authorization'] is None:return {'configured':False,'grantsCreated':False}
 selected=cfg['authorization'];source=strict_json(private_read(selected['config'],65536));require(source.get('version')==1,'custody-invalid')
 goal_path=selected.get('goalPrivateConfig');require(goal_path,'adapter-unavailable');goal=strict_json(private_read(goal_path,65536));require(goal.get('version')==1 and goal.get('mode') in ('owner-only','owner-and-employee'),'custody-invalid')
 nonce=goal['nonce'];path=Path(goal['paths']['nonce']['host']);require(str(__import__('uuid').UUID(nonce['storeId']))==nonce['storeId'] and type(nonce['capacity']) is int and 1<=nonce['capacity']<=4096,'custody-invalid')
 # The actual Goal bootstrap installer owns initialization and fresh namespace/mount admission.
 old=strict_json(private_read(path,4*1024*1024));require(old.get('version')==1 and old.get('storeId')==nonce['storeId'] and old.get('capacity')==nonce['capacity'] and isinstance(old.get('entries'),list) and len(old['entries'])<=nonce['capacity'],'custody-invalid')
 require(private_read(Path(str(path)+'.lock'),0)==b'','custody-invalid')
 matches=[p for p in source['principals'] if p.get('principal')==selected['principal']];require(len(matches)==1,'custody-invalid');key=Path(matches[0]['key']);private_directory(key.parent,create=True)
 if not key.exists():require(allow_initialize,'not-installed');atomic_private(key,os.urandom(32))
 require(len(private_read(key,32))==32,'custody-invalid')
 return {'configured':True,'grantsCreated':False,'nonceStoreId':nonce['storeId'],'canonicalGoalBootstrapRequired':True,'qualifiedCustodyClaimed':False,'webLaunchArguments':['--goal-private-config','--service-auth-config'],'configDigest':digest(source)}

def unit_bytes(launcher,config):
 escape=lambda p:'"'+str(p).replace('\\','\\\\').replace('"','\\"').replace('%','%%').replace('$','$$')+'"'
 return ('[Unit]\nDescription=Reverie authenticated OPS core\nAfter=default.target\n[Service]\nType=simple\nExecStart='+escape(launcher)+' --config '+escape(config)+'\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\nMemoryMax=512M\nTasksMax=64\nTimeoutStopSec=20\n[Install]\nWantedBy=default.target\n').encode()

def replace_private(path,data,expected):
 path=Path(path);prior=private_read(path,65536);require(hashlib.sha256(prior).hexdigest()==expected,'not-installed')
 temporary=path.with_name('.'+path.name+'.replace-'+__import__('uuid').uuid4().hex);atomic_private(temporary,data)
 require(private_read(path,65536)==prior,'not-installed');os.replace(temporary,path);fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)

class Installer:
 def __init__(self,config,launcher,manifest,home=None,run=subprocess.run):self.path=Path(config);self.launcher=Path(launcher);self.manifest=Path(manifest);self.home=Path.home() if home is None else Path(home);self.run=run
 def manager(self,*args):
  result=self.run(['systemctl','--user',*args],capture_output=True,text=True,timeout=30);require(result.returncode==0,'not-installed');return result.stdout
 def check(self):
  require(sys.platform=='linux' and os.geteuid()!=0,'unsupported-platform');cfg=load_configuration(self.path)
  for p in (self.launcher,self.manifest):
   require(p.is_absolute() and p.resolve()==p and str(p).startswith('/nix/store/'),'custody-invalid');s=p.stat();require(stat.S_ISREG(s.st_mode) and s.st_uid in (0,os.getuid()) and not s.st_mode&0o022,'custody-invalid')
  require(cfg['packageManifest']==str(self.manifest),'not-installed');engine=Engine(cfg['engineBinary'],cfg['engineSocket'],cfg['engineConfigDirectory']);Custody(cfg,engine,self.path)();
  for resource in cfg['resources'].values():DockerWebsite(resource,engine,cfg['companyFile'],os.getuid())
  self.manager('is-active','default.target');return cfg
 def install(self):
  require(sys.platform=='linux' and os.geteuid()!=0,'unsupported-platform');cfg=load_configuration(self.path)
  for field in ('stateDirectory','socketDirectory','engineConfigDirectory'):private_directory(cfg[field],create=True)
  marker=Path(cfg['stateDirectory'])/'.reverie-ops-state.json';mark=canonical({'application':'reverie-ops','version':1})+b'\n'
  if marker.exists():require(private_read(marker,4096)==mark,'custody-invalid')
  else:
   require(not any(Path(cfg['stateDirectory']).iterdir()),'custody-invalid');atomic_private(marker,mark)
  cfg=self.check()
  for field in ('stateDirectory','socketDirectory','engineConfigDirectory'):private_directory(cfg[field],create=True)
  prior_install=Path(cfg['stateDirectory'])/'installation.json'
  authority=prepare_authority_state(cfg,allow_initialize=not prior_install.exists())
  # Secret generation is host-only, exclusive and stable across repeated setup.
  key=Path(cfg['requestKey']);private_directory(key.parent,create=True)
  if not key.exists():require(not prior_install.exists(),'not-installed');atomic_private(key,os.urandom(32))
  require(len(private_read(key,32))==32,'custody-invalid')
  manifest=strict_json(self.manifest.read_bytes());receipt={'version':1,'packageDigest':digest(manifest),'configDigest':digest(cfg),'launcher':str(self.launcher),'configSnapshot':cfg,'unitDigest':hashlib.sha256(unit_bytes(self.launcher,self.path)).hexdigest()}
  atomic_private(Path(cfg['stateDirectory'])/'installation.json',canonical(receipt)+b'\n')
  # A GC root retains the entire closure. Reinstallation preserves audit/fence/key state.
  closure=Path('/nix/store')/self.launcher.relative_to('/nix/store').parts[0];gc=self.home/'.local/state/reverie/services/ops/generations'/closure.name;private_directory(gc.parent,create=True)
  if gc.is_symlink():require(gc.resolve()==closure,'not-installed')
  elif gc.exists():raise Refusal('custody-invalid')
  else:
   r=self.run(['nix-store','--add-root',str(gc),'--indirect','--realise',str(closure)],capture_output=True,text=True,timeout=60);require(r.returncode==0 and gc.is_symlink() and gc.resolve()==closure,'not-installed')
  atomic_private(self.home/'.config/systemd/user'/UNIT,unit_bytes(self.launcher,self.path));self.manager('daemon-reload');self.manager('enable',UNIT)
  return {'installed':True,'started':False,'authorityCreated':False,'authorityBootstrap':authority,'receiptDigest':digest(receipt)}
 def upgrade(self,expected):
  sha(expected);cfg=self.check();state=Path(cfg['stateDirectory']);record=state/'installation.json';raw=private_read(record,65536);old=strict_json(raw);require(digest(old)==expected,'not-installed')
  previous=dict(old['configSnapshot']);current=dict(cfg);previous.pop('packageManifest');current.pop('packageManifest');require(previous==current,'custody-invalid')
  # A code generation update cannot change grant references, target image/container or schema floor.
  props=dict(line.split('=',1) for line in self.manager('show',UNIT,'--property=ActiveState,SubState,MainPID,ControlPID').splitlines() if '=' in line)
  require(props=={'ActiveState':'inactive','SubState':'dead','MainPID':'0','ControlPID':'0'},'resource-busy')
  unit=self.home/'.config/systemd/user'/UNIT;prior=private_read(unit,65536);new_unit=unit_bytes(self.launcher,self.path);require(hashlib.sha256(prior).hexdigest() in (old['unitDigest'],hashlib.sha256(new_unit).hexdigest()),'not-installed')
  closure=Path('/nix/store')/self.launcher.relative_to('/nix/store').parts[0];gc=self.home/'.local/state/reverie/services/ops/generations'/closure.name;private_directory(gc.parent,create=True);require(len(list(gc.parent.iterdir()))<64 or gc.exists(),'audit-unavailable')
  if gc.is_symlink():require(gc.resolve()==closure,'not-installed')
  elif gc.exists():raise Refusal('custody-invalid')
  else:
   r=self.run(['nix-store','--add-root',str(gc),'--indirect','--realise',str(closure)],capture_output=True,text=True,timeout=60);require(r.returncode==0 and gc.is_symlink() and gc.resolve()==closure,'not-installed')
  manifest=strict_json(self.manifest.read_bytes());replacement={'version':1,'packageDigest':digest(manifest),'configDigest':digest(cfg),'launcher':str(self.launcher),'configSnapshot':cfg,'unitDigest':hashlib.sha256(new_unit).hexdigest()}
  if prior!=new_unit:replace_private(unit,new_unit,hashlib.sha256(prior).hexdigest())
  replace_private(record,canonical(replacement)+b'\n',hashlib.sha256(raw).hexdigest());self.manager('daemon-reload')
  audit=state/'installation-history.jsonl';fd=os.open(audit,os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
  with os.fdopen(fd,'ab') as stream:stream.write(canonical({'at':now(),'before':expected,'after':digest(replacement),'auditPreserved':True,'started':False})+b'\n');stream.flush();os.fsync(stream.fileno())
  return {'installed':True,'upgraded':True,'started':False,'authorityCreated':False,'receiptDigest':digest(replacement)}
 def action(self,action):
  if action=='install':return self.install()
  self.check()
  if action=='start':
   require(private_read(self.home/'.config/systemd/user'/UNIT,65536)==unit_bytes(self.launcher,self.path),'not-installed');self.manager('start',UNIT);return {'started':True,'effectsInvoked':False}
  if action=='status':return {'service':self.manager('show',UNIT,'--property=ActiveState,SubState,FragmentPath').strip(),'authorityCreated':False}
  raise Refusal()

def main(argv=None):
 parser=argparse.ArgumentParser(description=__doc__,allow_abbrev=False);parser.add_argument('--config',required=True);parser.add_argument('action',choices=('check','install','upgrade','start','status'));parser.add_argument('--expect-installation');args=parser.parse_args(argv)
 try:
  launcher=os.environ.get('REVERIE_OPS_LAUNCHER');manifest=os.environ.get('REVERIE_OPS_MANIFEST');require(launcher and manifest,'not-installed');i=Installer(args.config,launcher,manifest);r=i.check() if args.action=='check' else i.upgrade(args.expect_installation) if args.action=='upgrade' else i.action(args.action)
  print(canonical({'checked':True,'effectsInvoked':False} if args.action=='check' else r).decode());return 0
 except (Refusal,OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError):print('OPS installation unavailable: verify private configuration, custody and packaged user service.',file=sys.stderr);return 1
if __name__=='__main__':raise SystemExit(main())
