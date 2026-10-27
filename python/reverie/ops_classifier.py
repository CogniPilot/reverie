"""G1 attests and executes the exact reviewed Broker.inspect_container method, never a second grammar."""
import ast,hashlib,json,os,re,stat,subprocess
from pathlib import Path
from .ops_common import Refusal,require
from .ops_worker_classifier import inspect_container as reviewed_inspect_container
UNIT='reverie-worker-broker.service'
def method_source(source):
 tree=ast.parse(source);classes=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Broker'];require(len(classes)==1,'adapter-unavailable');methods=[n for n in classes[0].body if isinstance(n,ast.FunctionDef) and n.name=='inspect_container'];require(len(methods)==1,'adapter-unavailable');return ast.get_source_segment(source,methods[0])
class WorkerClassifier:
 def __init__(self,pin,systemctl,broker_config):self.pin=pin;self.systemctl=str(systemctl);self.broker_config=str(broker_config)
 def binding(self):
  result=subprocess.run([self.systemctl,'--user','show',UNIT,'--property=MainPID','--value'],capture_output=True,text=True,timeout=3,env={'PATH':os.defpath,'LANG':'C','LC_ALL':'C'});require(result.returncode==0 and result.stdout.strip().isdigit(),'adapter-unavailable');pid=int(result.stdout.strip());require(pid>1,'adapter-unavailable')
  raw=(Path('/proc')/str(pid)/'cmdline').read_bytes();require(len(raw)<16384,'adapter-unavailable');args=[x.decode() for x in raw.split(b'\0') if x]
  sources=[Path(v) for v in args if v.startswith('/nix/store/') and v.endswith('/python/reverie/worker.py')];require(len(sources)==1 and '--config' in args and args[args.index('--config')+1]==self.broker_config,'adapter-unavailable');source=sources[0];require(source.resolve()==source,'custody-invalid')
  for p in [*reversed(source.parents),source]:
   info=p.lstat();require(info.st_uid==0 and not info.st_mode&0o022 and not stat.S_ISLNK(info.st_mode),'custody-invalid')
  fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
  try:
   info=os.fstat(fd);require(stat.S_ISREG(info.st_mode) and info.st_size<=2*1024*1024,'custody-invalid');text=os.read(fd,2*1024*1024+1).decode();require(len(text.encode())==info.st_size,'custody-invalid')
  finally:os.close(fd)
  method=method_source(text);require(hashlib.sha256(method.encode()).hexdigest()==self.pin['methodSha256'],'adapter-unavailable')
  return {'pid':pid,'sourceSha256':hashlib.sha256(text.encode()).hexdigest(),'methodSha256':self.pin['methodSha256']},method
 def available(self):
  try:self.binding();return True
  except Exception:return False
 def inspect_absent(self,engine,name):
  before,source=self.binding()
  calls=[]
  class Proxy:
   def run_engine(self,args,optional=False):
    # The exact pinned method may only inspect this generated name or list all container names.
    require(args in (['inspect',name],['ps','--all','--format','{{.Names}}']),'adapter-unavailable');code,out,error=engine.run(args);calls.append((list(args),code));result=subprocess.CompletedProcess(args,code,out.decode(errors='replace'),error.decode(errors='replace'))
    if code and not optional:raise RuntimeError('fixed engine inventory failed')
    return result
  try:result=reviewed_inspect_container(Proxy(),name);matched=result=={'State':{'Running':False}} and calls==[(['inspect',name],calls[0][1]),(['ps','--all','--format','{{.Names}}'],0)]
  except Exception:matched=False
  after,_=self.binding();require(before==after,'adapter-unavailable');return matched,before
