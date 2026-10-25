"""Fixed installed Docker adapter. No caller-selected command, socket, image, URL or identity."""
import contextlib,hashlib,http.client,os,re,selectors,signal,stat,subprocess,threading,time,uuid
from pathlib import Path
from .ops_common import *
from .ops_core import evidence
from .worker_storage import read_metadata

class Engine:
 def __init__(self,binary,socket,config_directory):
  p=Path(binary);require(p.is_absolute() and p.resolve()==p and stat.S_ISREG(p.stat().st_mode) and p.stat().st_uid in (0,os.getuid()) and not p.stat().st_mode&0o022,'custody-invalid')
  for directory in [*reversed(p.parents),p.parent]:
   info=directory.stat();require(info.st_uid==0 and not info.st_mode&0o022,'custody-invalid')
  require(p.stat().st_uid==0,'custody-invalid')
  self.local=threading.local()
  self.prefix=[str(p),'--config',str(private_directory(config_directory)),'--host','unix://'+str(Path(socket))]
  require(not any(Path(config_directory).iterdir()),'custody-invalid')
 @contextlib.contextmanager
 def budget(self,seconds):
  previous=getattr(self.local,'deadline',None);self.local.deadline=min(previous or float('inf'),time.monotonic()+seconds)
  try:yield
  finally:self.local.deadline=previous
 def run(self,args,timeout=20,limit=1024*1024):
  timeout=min(timeout,(getattr(self.local,'deadline',None) or float('inf'))-time.monotonic());require(timeout>0,'unknown-effect')
  p=subprocess.Popen([*self.prefix,*args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env={'PATH':os.defpath,'LANG':'C','LC_ALL':'C'})
  end=time.monotonic()+timeout;data={p.stdout:bytearray(),p.stderr:bytearray()};total=0
  try:
   with selectors.DefaultSelector() as selector:
    for stream in data:selector.register(stream,selectors.EVENT_READ)
    while selector.get_map():
     require(time.monotonic()<end,'unknown-effect')
     for item,_ in selector.select(max(0,min(1,end-time.monotonic()))):
      chunk=os.read(item.fd,65536)
      if not chunk:selector.unregister(item.fileobj)
      else:
       total+=len(chunk);require(total<=limit,'unknown-effect');data[item.fileobj].extend(chunk)
   p.wait(timeout=max(.001,end-time.monotonic()));return p.returncode,bytes(data[p.stdout]),bytes(data[p.stderr])
  finally:
   if p.poll() is None:
    os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
   p.stdout.close();p.stderr.close()

class DockerWebsite:
 adapter_id='docker-website';version='core-v1';installed=True
 def __init__(self,config,engine,company_file,uid,*,custody=lambda:None,ready=None,classifier=None,service_binding=None):
  self.config=config;self.engine=engine;self.company=company_file;self.uid=uid;self.custody=custody;self.ready=ready or self.readiness;self.classifier=classifier;self.service_binding=service_binding
  require(set(config)=={'containerId','image','deployment','employees','readiness','catalogue','schemaEpoch'},'invalid-request')
  require(re.fullmatch('[0-9a-f]{64}',config['containerId']) and SHA.fullmatch(config['image']) and re.fullmatch('[a-z0-9][a-z0-9-]{0,39}',config['deployment']),'invalid-request')
  require(isinstance(config['schemaEpoch'],str) and re.fullmatch('[a-z0-9][a-z0-9-]{0,95}',config['schemaEpoch']),'invalid-request')
  require(isinstance(config['employees'],list) and len(config['employees'])==len(set(config['employees'])) and all(UUID.fullmatch(e) for e in config['employees']),'invalid-request')
  require(isinstance(config['catalogue'],dict) and set(config['catalogue'])<=set(ACTIONS[2:4]),'invalid-request')
  for ref in config['catalogue'].values():
   shape(ref,('artifactId','digest','reviewId'));identifier(ref['artifactId']);identifier(ref['reviewId']);sha(ref['digest'])
  require(config['readiness'].get('host') in ('127.0.0.1','::1') and type(config['readiness'].get('port')) is int and 1<=config['readiness']['port']<=65535 and config['readiness'].get('path')=='/api/status','invalid-request')
 def binding_digest(self):return digest({'adapter':self.adapter_id,'version':self.version,'config':self.config,'source':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'executorBinding':self.service_binding,'classifierSource':hashlib.sha256(Path(__file__).with_name('ops_worker_classifier.py').read_bytes()).hexdigest()})
 def supports(self,action):
  if action in ACTIONS[:2]:return True
  if action==ACTIONS[2] and (self.classifier is None or not self.classifier.available()):return False
  return action in ACTIONS[2:4] and isinstance(self.config['catalogue'].get(action),dict) and self.artifact(action,self.config['catalogue'][action])
 def artifact(self,action,ref):
  if self.config['catalogue'].get(action)!=ref:return False
  if action==ACTIONS[3]:return ref['digest']==self.config['image']
  if action==ACTIONS[2]:return ref['artifactId']=='container-absence-diagnostic' and ref['digest']==self.suite_digest()
  return False
 def suite_digest(self):return digest({'suite':'container-absence-diagnostic','handlerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'classifierSha256':hashlib.sha256(Path(__file__).with_name('ops_worker_classifier.py').read_bytes()).hexdigest()})
 def get(self,args):
  code,out,_=self.engine.run(args);require(code==0,'adapter-unhealthy');return out
 def inspect_container(self,identity):
  rows=strict_json(self.get(['inspect','--type','container',identity]));require(isinstance(rows,list) and len(rows)==1,'adapter-unhealthy');return rows[0]
 def process(self,pid):
  require(type(pid) is int and pid>1,'adapter-unhealthy')
  try:
   raw=Path('/proc',str(pid),'stat').read_text();fields=raw.rsplit(')',1)[1].split();return {'pid':pid,'startTicks':int(fields[19])}
  except (OSError,ValueError,IndexError):raise Refusal('adapter-unhealthy')
 def snapshot(self):
  with self.engine.budget(20):return self._snapshot()
 def _snapshot(self):
  binding=self.custody();c=self.config;website=self.inspect_container(c['containerId']);
  if binding is not None:require(website.get('Name')=='/'+binding['serverContainer'],'adapter-unhealthy')
  require(website['Id']==c['containerId'] and website['Image']==c['image'] and website['State']['Running'] is True,'adapter-unhealthy')
  web={'containerId':website['Id'],'image':website['Image'],'startedAt':website['State']['StartedAt'],'process':self.process(website['State']['Pid'])}
  ids=self.get(['ps','--no-trunc','-q','--filter','label=reverie.worker='+c['deployment']]).decode().split();require(all(re.fullmatch('[0-9a-f]{64}',i) for i in ids),'adapter-unhealthy')
  workers={}
  state=read_metadata(self.company,self.uid);employees=state.get('employees',[]);selected={e['id']:e for e in employees if e.get('id') in c['employees']}
  require(len(selected)==len(c['employees']),'adapter-unhealthy')
  for identity in ids:
   item=self.inspect_container(identity);labels=item['Config'].get('Labels') or {};sid=labels.get('reverie.session');matches=[e for e in selected.values() if e.get('sessionId')==sid]
   require(item['Id']==identity and item['State']['Running'] is True and labels.get('reverie.worker')==c['deployment'] and len(matches)==1,'adapter-unhealthy')
   employee=matches[0];require(employee['id'] not in workers,'adapter-unhealthy')
   lines=self.get(['top',identity,'-eo','pid,lstart,comm']).decode().splitlines();processes=[]
   require(len(lines)>1,'adapter-unhealthy')
   for line in lines[1:]:
    parts=line.split();require(parts and parts[0].isdigit(),'adapter-unhealthy');processes.append(self.process(int(parts[0])))
   workers[employee['id']]={'containerId':identity,'image':item['Image'],'sessionId':sid,'startedAt':item['State']['StartedAt'],'init':self.process(item['State']['Pid']),'processes':sorted(processes,key=lambda p:p['pid']),'providerBinding':digest({k:employee.get(k) for k in ('id','sessionId','owner','runtimeRecipe')})}
  require(set(workers)==set(c['employees']),'adapter-unhealthy')
  return {'website':web,'workers':workers,'schemaEpoch':c['schemaEpoch']}
 def generation(self,snapshot):return digest({'binding':self.binding_digest(),'website':snapshot['website'],'schemaEpoch':self.config['schemaEpoch']})
 def readiness(self):
  cfg=self.config['readiness'];connection=http.client.HTTPConnection(cfg['host'],cfg['port'],timeout=2)
  try:
   connection.request('GET',cfg['path'],headers={'Host':'localhost'});r=connection.getresponse();r.read(4096);return r.status in cfg.get('statuses',[200,401])
  except (OSError,http.client.HTTPException):return False
  finally:connection.close()
 def preservation(self,before,after):
  if set(before['workers'])!=set(after['workers']):return False,False
  laptop=True;provider=True
  for eid,prior in before['workers'].items():
   current=after['workers'][eid]
   laptop&=all(current[k]==prior[k] for k in ('containerId','image','sessionId','startedAt','init'))
   provider&=current['providerBinding']==prior['providerBinding'] and all(p in current['processes'] for p in prior['processes'])
  return bool(laptop),bool(provider)
 def reconcile(self,before,current):
  laptops,providers=self.preservation(before,current)
  require(laptops and providers and self.ready() and current['website']['image']==self.config['image'] and current.get('schemaEpoch')==self.config['schemaEpoch'],'reconciliation-required')
  return [evidence('resource-state-known','pass',{'generation':self.generation(current)}),evidence('artifact-matches','pass',current['website']),evidence('laptops-preserved','pass',current['workers']),evidence('providers-preserved','pass',current['workers']),evidence('application-ready','pass',{'ready':True})]
 def diagnostic(self):
  require(self.classifier is not None and self.classifier.available(),'adapter-unavailable');name='reverie-ops-absent-'+uuid.uuid4().hex
  matched,attestation=self.classifier.inspect_absent(self.engine,name)
  version=self.get(['version','--format','{{.Server.Version}}']).decode().strip();require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}',version),'adapter-unhealthy')
  diagnostic={'engineCategory':'docker','engineVersion':version,'matched':matched};ev=evidence('container-absence-diagnostic','pass' if matched else 'fail',{'diagnostic':diagnostic,'installedClassifier':attestation});ev['diagnostic']=diagnostic;return matched,ev
 def execute(self,action,artifact,before,begin):
  with self.engine.budget(120):return self._execute(action,artifact,before,begin)
 def _execute(self,action,artifact,before,begin):
  require(self.artifact(action,artifact),'unreviewed-artifact')
  if action==ACTIONS[2]:
   begin();matched,diag=self.diagnostic();after=self.snapshot();known=evidence('resource-state-known','pass',{'generation':self.generation(after)});ev=[evidence('suite-reviewed','pass',artifact),evidence('selftest-results-complete','pass',{'complete':True}),evidence('effects-within-scope','pass',{'readOnlyEngine':True}),diag]
   if not matched:return 'failed','selftest-failed',[known,*ev],self.generation(after)
   return 'verified','none',[*ev,evidence('selftest-passed','pass',{'complete':True})],self.generation(after)
  require(action==ACTIONS[3],'adapter-unavailable');begin()
  code,_,_=self.engine.run(['restart','--time','20',self.config['containerId']],timeout=45)
  if code!=0:return 'unconfirmed','unknown-effect',[evidence('resource-state-known','unknown',{'engineOutcome':'nonzero'})],None
  deadline=time.monotonic()+60;after=None
  while time.monotonic()<deadline:
   try:
    candidate=self.snapshot();changed=candidate['website']['process']!=before['website']['process'] and candidate['website']['startedAt']!=before['website']['startedAt']
    if changed and self.ready():after=candidate;break
   except Exception:pass
   time.sleep(.5)
  if after is None:return 'unconfirmed','verification-failed',[evidence('application-ready','unknown',{'code':'readiness-or-new-process-not-proven'})],None
  laptops,providers=self.preservation(before,after)
  if not (laptops and providers):return 'unconfirmed','verification-failed',[evidence('laptops-preserved','pass' if laptops else 'unknown',after['workers']),evidence('providers-preserved','pass' if providers else 'unknown',after['workers'])],None
  return 'verified','none',[evidence('artifact-matches','pass',after['website']),evidence('website-process-changed','pass',{'before':before['website'],'after':after['website']}),evidence('application-ready','pass',{'ready':True}),evidence('laptops-preserved','pass',after['workers']),evidence('providers-preserved','pass',after['workers'])],self.generation(after)
