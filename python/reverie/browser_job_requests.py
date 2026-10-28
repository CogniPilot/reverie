"""Fixed public browser job through a host-owned office socket; no generic OPS.

Request bodies contain references only. Identity is the OfficeAPI closure SID.
Canonical website facts, selected private policy and current native custody are
all required. An absent policy installs no callback and starts no process.
"""
import base64,copy,fcntl,gzip,hashlib,http.client,ipaddress,json,os,re,stat,tarfile,threading,time,uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlencode
from .worker_storage import read_metadata,storage_paths,storage_start_allowed
from .worker_resources import policy_digest
from .worker_resource_reservations import NativeObserver,_directory
from .workspaces import Workspaces
from .browser_job_policy import load_browser_job_policy
from .host_job_scope import FixedHostJobSpec,_program,_sha

UUID=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',re.I)
SHA=re.compile(r'^[a-f0-9]{64}$')
class BrowserJobRefused(ValueError):pass
class BrowserJobUnconfirmed(RuntimeError):pass
def need(value,message):
    if not value:raise BrowserJobRefused(message)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(value):return hashlib.sha256(canonical(value)).hexdigest()
@contextmanager
def serial_slot(lock):
    need(lock.acquire(blocking=False),'FIXED_JOB_BUSY_INSPECT_LATER')
    try:yield
    finally:lock.release()
def private_bytes(path,maximum=1048576):
    path=Path(path);need(path.is_absolute()and path.resolve()==path,'PRIVATE_PATH');fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        a=os.fstat(fd);stamp=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        need(stat.S_ISREG(a.st_mode)and a.st_uid==os.getuid()and a.st_nlink==1 and stat.S_IMODE(a.st_mode)==0o600 and a.st_size<=maximum,'PRIVATE_CUSTODY');raw=bytearray()
        while len(raw)<=maximum:
            chunk=os.read(fd,min(65536,maximum+1-len(raw)))
            if not chunk:break
            raw.extend(chunk)
        need(len(raw)==a.st_size and stamp(a)==stamp(os.fstat(fd))==stamp(path.lstat()),'PRIVATE_DRIFT');return bytes(raw)
    finally:os.close(fd)
def exclusive(path,value):
    raw=canonical(value)+b'\n';need(len(raw)<=1048576,'RECORD_BOUND');fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        while raw:n=os.write(fd,raw);need(n>0,'SHORT_WRITE');raw=raw[n:]
        os.fsync(fd)
    finally:os.close(fd)
    d=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:os.fsync(d)
    finally:os.close(d)
def command(value):
    need(type(value)is dict and set(value)=={'action','requestMessageId'}and value['action']in('submit','inspect','cancel')and type(value['requestMessageId'])is str and UUID.fullmatch(value['requestMessageId']),'FIXED_REQUEST_ONLY');return value

def decode_command(raw):
    need(type(raw)is bytes and len(raw)<=1024,'FIXED_REQUEST_BOUND')
    def unique(items):
        value={}
        for k,v in items:
            need(k not in value,'DUPLICATE_REQUEST_FIELD');value[k]=v
        return value
    return command(json.loads(raw.decode('utf-8'),object_pairs_hook=unique))

def selected_actor(broker,sid):
    need(type(sid)is str and UUID.fullmatch(sid),'CURRENT_ACTOR');state=read_metadata(broker.config['companyFile'],broker.config['uid']);employees=state.get('employees');retired=state.get('retired',[])
    need(type(employees)is list and type(retired)is list and len(employees)+len(retired)<=10000,'CURRENT_ACTOR')
    need(all(type(e)is dict for e in employees+retired),'CURRENT_ACTOR')
    need(len({e.get('id')for e in employees})==len(employees)and len({e.get('sessionId')for e in employees})==len(employees),'AMBIGUOUS_ACTOR')
    rows=[e for e in employees if e.get('sessionId')==sid];need(len(rows)==1 and not any(e.get('sessionId')==sid for e in retired),'CURRENT_ACTOR');e=rows[0]
    need(e.get('desiredRunning')is True and not e.get('onVacation')and not e.get('bindingMigration')and type(e.get('sessionGeneration'))is int and e['sessionGeneration']>0 and type(e.get('runtimeRecipe'))is dict,'CURRENT_ACTOR')
    return {'employeeId':e['id'],'sessionId':sid,'sessionGeneration':e['sessionGeneration'],'owner':e.get('owner')},e

def actor_binding(actor,employee):
    # Ordinary provider thread cursors and display/heartbeat metadata are not
    # account switches. Eligibility is independently rechecked by selected_actor.
    return {'actor':actor,'recipe':{k:v for k,v in employee['runtimeRecipe'].items()if k!='runtimeThreads'}}

def grant_identity(path):
    s=Path(path).stat();need(stat.S_ISDIR(s.st_mode)or stat.S_ISREG(s.st_mode)or stat.S_ISSOCK(s.st_mode),'NATIVE_ACCOUNT_GRANT_KIND');return(s.st_dev,s.st_ino,stat.S_IFMT(s.st_mode))

def qualify_sources(policy):
    """Fixed installed graph only; configuration cannot select arbitrary code."""
    parent=Path(__file__).resolve(strict=True).parent
    need(parent.is_relative_to('/nix/store'),'INSTALLED_PRIVATE_ACTOR_REQUIRED')
    for name,expected in policy['pythonSource'].items():
        _program(str(parent/name),expected,False)
    for value in policy['tools'].values():_program(value['path'],value['sha256'])
    for name in('runner','driver','vulkanIcd'):
        value=policy[name];_program(value['path'],value['sha256'],False)
    # These two reviewed private data modules are pinned before any import in
    # the own Node scope. A worker-writable replacement can only cause refusal.
    for name in('capture','manifest'):
        value=policy[name];raw=private_bytes(value['path'],8388608)
        need(hashlib.sha256(raw).hexdigest()==value['sha256'],'REVIEWED_CAPTURE_CHANGED')

def artifact_members(task,maximum):
    """Only sealed regular capture/proof files, with archive-relative names."""
    result=[];total=0
    for directory in('capture','artifacts'):
        root=task/'f'/directory
        if not root.exists():continue
        need(root.resolve()==root and root.is_dir(),'ARTIFACT_DIRECTORY')
        for path in sorted(root.iterdir()):
            need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',path.name),'ARTIFACT_NAME')
            s=path.lstat();need(stat.S_ISREG(s.st_mode)and s.st_uid==os.getuid()and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600,'SEALED_OWN_ARTIFACT')
            total+=s.st_size;need(total<=maximum and len(result)<512,'ARTIFACT_EXPORT_BOUND');result.append((directory+'/'+path.name,path,(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)))
    need(result,'NO_CAPTURE_ARTIFACTS');return result

def stream_artifacts(members,send):
    """A bounded gzip/tar stream; at most one16MiB part in host memory."""
    class Parts:
        def __init__(self):self.buffer=bytearray();self.parts=[];self.total=0
        def write(self,data):
            original=len(data);self.total+=original;need(self.total<=268435456+1048576,'COMPRESSED_EXPORT_BOUND')
            while data:
                n=min(16777216-len(self.buffer),len(data));self.buffer.extend(data[:n]);data=data[n:]
                if len(self.buffer)==16777216:self.flush_part()
            return original
        def flush_part(self):
            if self.buffer:
                need(len(self.parts)<17,'EXPORT_PART_BOUND');raw=bytes(self.buffer);self.buffer.clear();self.parts.append(send(len(self.parts)+1,raw,hashlib.sha256(raw).hexdigest()))
        def flush(self):pass
    sink=Parts()
    with gzip.GzipFile(filename='',fileobj=sink,mode='wb',mtime=0)as compressed:
        with tarfile.open(fileobj=compressed,mode='w|',format=tarfile.USTAR_FORMAT)as archive:
            for name,path,expected in members:
                fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
                with os.fdopen(fd,'rb')as file:
                    stamp=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
                    need(stamp(os.fstat(file.fileno()))==expected,'ARTIFACT_REPLACED');info=tarfile.TarInfo(name);info.size=expected[2];info.mode=0o600;archive.addfile(info,file);need(stamp(os.fstat(file.fileno()))==stamp(path.lstat())==expected,'ARTIFACT_CHANGED_DURING_EXPORT')
    sink.flush_part();return sink.parts

class BrowserJobRequests:
    """Installed fixed callback, created only by Broker from its private config."""
    def __init__(self,broker,policy_path):
        self.broker=broker;loaded=load_browser_job_policy(broker.config);need(loaded is not None and loaded.path==Path(policy_path),'JOB_POLICY')
        self.path=loaded.path;self.policy_sha=loaded.sha256;self.policy=loaded.document;p=self.policy;self.root=Path(p['controlRoot']);fd,_=_directory(self.root,os.getuid());os.close(fd)
        # The existing authoritative observer includes configured broad/RO and
        # actual running/stopped mounts plus namespace aliases. It is not a0700-only claim.
        self.native=NativeObserver(broker);self.native.custody(self.root,self.path)
        self.guard_lock=threading.Lock();self.jobs={}
        need(broker.resource_reservations is not None,'COMMON_NATIVE_CAPACITY_NOT_INSTALLED')
        qualify_sources(p)
    def custody(self,deadline=None):
        need(not self.broker.stopping.is_set()and not self.broker.draining.is_set(),'BROKER_STOP_OR_DRAIN')
        need(hashlib.sha256(private_bytes(self.path)).hexdigest()==self.policy_sha,'JOB_POLICY_CHANGED');fd,_=_directory(self.root,os.getuid());os.close(fd)
        if deadline is None:self.native.custody(self.root,self.path)
        else:self.native.custody(self.root,self.path,deadline=deadline)
    def website(self,deadline=None,native_expected=None):
        rows=self.native.inventory(deadline)
        if native_expected is not None:
            sid=native_expected['currentActor']['sessionId'];matches=[r for r in rows if(r.get('Config',{}).get('Labels')or{}).get('reverie.worker')==self.broker.config['deployment']and(r.get('Config',{}).get('Labels')or{}).get('reverie.session')==sid]
            need(len(matches)==1 and digest(matches[0])==native_expected['engineRowSHA256'],'CURRENT_NATIVE_WORKER_CHANGED_AFTER_IO')
        name=self.broker.config['serverContainer'];matches=[x for x in rows if x.get('Name')in(name,'/'+name)]
        need(len(matches)==1,'WEBSITE_IDENTITY');v=matches[0];need(v.get('State',{}).get('Running')is True,'WEBSITE_STOPPED')
        pid=v['State']['Pid'];need(type(pid)is int and pid>1,'WEBSITE_PID');fields=(Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split();need(fields[0]not in('Z','X'),'WEBSITE_PID');return {'containerId':v['Id'],'image':v['Image'],'pid':pid,'startTick':fields[19]}
    def native_actor(self,actor,employee,deadline):
        """Reuse the canonical observer/resolver; no new capacity producer."""
        config=self.broker.config;sid=actor['sessionId'];paths=storage_paths(config,sid)
        need(paths.kind=='employee'and paths.identity==actor['employeeId']and paths.owner==actor['owner']and storage_start_allowed(config,paths),'CURRENT_NATIVE_EMPLOYEE_STORAGE')
        def selected(rows):
            matches=[r for r in rows if(r.get('Config',{}).get('Labels')or{}).get('reverie.worker')==config['deployment']and(r.get('Config',{}).get('Labels')or{}).get('reverie.session')==sid]
            need(len(matches)==1,'CURRENT_NATIVE_WORKER_UNIQUE');return matches[0]
        row=copy.deepcopy(selected(self.native.inventory(deadline)));labels=row['Config']['Labels']
        need(row.get('Name')=='/'+config['deployment']+'-agent-'+sid and row.get('State',{}).get('Running')is True and labels.get('reverie.employee')==actor['employeeId']and labels.get('reverie.storage')=='employee:'+actor['employeeId']and labels.get('reverie.worker-policy')==policy_digest(config,sid),'CURRENT_NATIVE_WORKER_BINDING')
        _,native=self.native.limits(row);storage=self.native.storage(row,paths);grants=[]
        for mount in config['mounts']:
            found=[m for m in row['Mounts']if m.get('Destination')==mount['destination']]
            need(len(found)==1 and found[0].get('Type')=='bind'and found[0].get('RW')is(not mount['readOnly']),'CURRENT_NATIVE_ACCOUNT_GRANT')
            expected=grant_identity(mount['source']);actual=grant_identity(found[0]['Source']);guest=grant_identity(Path('/proc')/str(native['pid'])/'root'/mount['destination'].lstrip('/'))
            need(expected==actual==guest==grant_identity(mount['source']),'CURRENT_NATIVE_ACCOUNT_ROOT');grants.append({'destination':mount['destination'],'readOnly':mount['readOnly'],'identity':expected})
        # Kernel/physical-root reads can block. The last engine row must match,
        # then only trusted current employee/resolver metadata is consulted.
        need(selected(self.native.inventory(deadline))==row,'CURRENT_NATIVE_WORKER_CHANGED')
        current,e=selected_actor(self.broker,sid);need(actor_binding(current,e)==actor_binding(actor,employee)and storage_paths(config,sid)==paths and storage_start_allowed(config,paths),'CURRENT_NATIVE_ACCOUNT_CHANGED')
        return {'currentActor':actor,'native':native,'storage':storage,'grantsSHA256':digest(grants),'engineRowSHA256':digest(row)}
    def canonical_source(self,sid,message,deadline=None):
        actor,employee=selected_actor(self.broker,sid);expected={k:v for k,v in self.policy['actor'].items()if k!='recipeSHA256'};need(actor==expected,'CURRENT_SELECTED_ACTOR');before=self.website(deadline)
        cue=self.policy['ownerCue'];route='/api/chatrooms/'+cue['roomId']+'/messages/'+message+'/browser-job-evidence'
        value=self.office_exchange(sid,'GET',route,b'','application/json',deadline)['data']
        need(type(value)is dict,'CANONICAL_SCHEMA')
        native=self.native_actor(actor,employee,deadline)
        need(self.website(deadline,native_expected=native)==before,'WEBSITE_INCARNATION_CHANGED');current,e=selected_actor(self.broker,sid);need(actor_binding(current,e)==actor_binding(actor,employee),'CURRENT_ACTOR_CHANGED')
        need(value.get('kind')=='CANONICAL_FIXED_BROWSER_JOB_SOURCE'and value.get('version')==1 and value.get('jobKey')=='slam-office640'and UUID.fullmatch(value.get('serverEpoch','')),'CANONICAL_SCHEMA')
        need(value.get('actor')==self.policy['actor'],'CURRENT_ACCOUNT_BINDING');source=value.get('source',{});owner=value.get('ownerCue',{});need(type(source)is dict and type(owner)is dict,'CANONICAL_SCHEMA')
        need(source.get('at',0)>=self.policy['notBeforeMS'],'REQUEST_PRECEDES_BINDING_POLICY');need(source.get('roomId')==cue['roomId']and source.get('messageId')==message and source.get('replyTo')==cue['messageId']and SHA.fullmatch(source.get('sha256','')),'EXACT_REQUEST_SOURCE')
        need(owner.get('messageId')==cue['messageId']and owner.get('sha256')==cue['sha256']and owner.get('mark')in('owner_typed','owner_spoken'),'EXACT_STANDING_OWNER_CUE')
        return {'canonical':value,'website':before,'nativeActor':native,'policySHA256':self.policy_sha,'actorSHA256':digest(actor),'sourceSHA256':source['sha256']}
    def office_exchange(self,sid,method,path,body,content_type,deadline):
        room=self.policy['ownerCue']['roomId'];base='/api/chatrooms/'+room
        allowed=(method=='POST'and(path==base+'/messages'or path.startswith(base+'/files?')))or(method=='GET'and re.fullmatch(re.escape(base)+r'/messages/[a-fA-F0-9-]{36}/browser-job-evidence',path))
        need(allowed,'FIXED_OFFICE_ROUTE');need(type(body)is bytes and len(body)<=16777216,'ARTIFACT_HTTP_BOUND');deadline=min(time.monotonic()+10,deadline)if deadline is not None else time.monotonic()+10;connection=None
        try:
            # Exactly the existing office upstream credential family, host-only;
            # no owner cookie/PAT/worker supplied Authorization is accepted.
            raw=private_bytes(Path(self.broker.config['companyRoot'])/'console/.env',65536).decode();env=dict(line.split('=',1)for line in raw.splitlines()if '='in line)
            need('REVERIE_PASSWORD'in env,'OFFICE_AUTH_UNAVAILABLE');auth=base64.b64encode((env.get('REVERIE_USERNAME','admin')+':'+env['REVERIE_PASSWORD']).encode()).decode()
            def remaining():
                value=min(5,deadline-time.monotonic());need(value>0,'OFFICE_ABSOLUTE_DEADLINE');return value
            address=self.broker.address();ipaddress.ip_address(address);connection=http.client.HTTPConnection(address,3000,timeout=remaining())
            connection.request(method,path,body,headers={'Host':'localhost:3000','Authorization':'Basic '+auth,'X-Reverie-Parent-Session':sid,'Content-Type':content_type});sock=connection.sock;need(sock is not None,'OFFICE_SOCKET_UNKNOWN');sock.settimeout(remaining());response=connection.getresponse()
            length=response.getheader('Content-Length');need(response.status==200 and response.getheader('Transfer-Encoding')is None and type(length)is str and length.isdecimal()and 0<int(length)<=16384,'CLOSED_OFFICE_RESPONSE');data=bytearray()
            while len(data)<int(length):
                sock.settimeout(remaining());part=response.read1(min(4096,int(length)-len(data)));need(part,'OFFICE_RESPONSE_TRUNCATED');data.extend(part)
            need(time.monotonic()<deadline,'OFFICE_ABSOLUTE_DEADLINE');envelope=json.loads(data);need(type(envelope)is dict and envelope.get('success')is True and type(envelope.get('data'))is dict,'OFFICE_RESPONSE_REFUSED');return envelope
        finally:
            if connection:connection.close()
    def authority(self,sid,message,original=None,deadline=None):
        self.custody(deadline);proof=self.canonical_source(sid,message,deadline);self.custody(deadline)
        # Native custody may perform blocking engine/kernel observations. The
        # canonical source/account and website are reread after it, not cached.
        fresh=self.canonical_source(sid,message,deadline);need(fresh==proof,'AUTHORITY_CHANGED_DURING_CUSTODY')
        if original is not None:need(fresh==original,'JOB_AUTHORITY_REVOKED')
        return fresh
    def office_post(self,sid,path,body,content_type,deadline):
        """Existing agent room endpoints only; no owner impersonation or proxy."""
        room=self.policy['ownerCue']['roomId'];need(path in('/api/chatrooms/'+room+'/messages',)or path.startswith('/api/chatrooms/'+room+'/files?'),'FIXED_ARTIFACT_ROUTE')
        return self.office_exchange(sid,'POST',path,body,content_type,deadline)['data']
    def deliver(self,task,record,deadline):
        sid=record['actor']['sessionId'];message=record['requestMessageId'];self.authority(sid,message,record['authority'],deadline=deadline);members=artifact_members(task,self.policy['limits']['outputBytes'])
        exclusive(task/'DELIVERY-ATTEMPT.json',{'kind':'ONE_SHOT_CAPTURE_ARTIFACT_DELIVERY','requestMessageId':message,'files':len(members),'at':time.time()})
        def send(number,raw,sha):
            self.authority(sid,message,record['authority'],deadline=deadline);name='capture-'+record['operationId']+'.tar.gz.part-'+str(number).zfill(3);route='/api/chatrooms/'+self.policy['ownerCue']['roomId']+'/files?'+urlencode({'name':name,'type':'application/octet-stream'})
            data=self.office_post(sid,route,raw,'application/octet-stream',deadline);file=data.get('file',{});need(UUID.fullmatch(file.get('id',''))and file.get('name')==name and file.get('size')==len(raw),'ARTIFACT_UPLOAD_UNCONFIRMED');self.authority(sid,message,record['authority'],deadline=deadline);return {'id':file['id'],'name':name,'bytes':len(raw),'sha256':sha}
        parts=stream_artifacts(members,send);posts=[]
        for start in range(0,len(parts),10):
            self.authority(sid,message,record['authority'],deadline=deadline);batch=parts[start:start+10];text='Fixed640x360/5Hz raw capture artifacts for job '+record['operationId']+'. Scientific interpretation and release acceptance remain with the requester. Concatenate archive parts in numeric order before extraction.\n'+'\n'.join(x['name']+' sha256:'+x['sha256']for x in batch)
            data=self.office_post(sid,'/api/chatrooms/'+self.policy['ownerCue']['roomId']+'/messages',canonical({'text':text,'attachments':[x['id']for x in batch],'replyTo':message,'requireAgent':True}),'application/json',deadline);posted=data.get('message',{});need(UUID.fullmatch(posted.get('id',''))and posted.get('from',{}).get('kind')=='agent'and posted.get('from',{}).get('sessionId')==sid,'ARTIFACT_POST_UNCONFIRMED');self.authority(sid,message,record['authority'],deadline=deadline);posts.append(posted['id'])
        receipt={'kind':'CAPTURE_ARTIFACTS_DELIVERED','parts':parts,'messages':posts,'requestMessageId':message,'scientificInterpretation':'REQUESTER_REQUIRED'};exclusive(task/'DELIVERY-DONE.json',receipt);return receipt
    def dispatch(self,sid,value):
        value=command(value);message=value['requestMessageId'];proof=self.authority(sid,message)
        with serial_slot(self.guard_lock):
            lock=os.open(self.root/'jobs.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
            try:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);need(stat.S_IMODE(os.fstat(lock).st_mode)==0o600,'JOB_LOCK_CUSTODY');index=self.root/('request-'+message+'.json')
                if index.exists():
                    record=json.loads(private_bytes(index));need(record.get('requestMessageId')==message and record.get('actor')==self.policy['actor'],'REQUEST_CONFLICT')
                    task=Path(record['task']);need(task.parent==self.root/'tasks'and task.resolve()==task and re.fullmatch('capture-[a-f0-9]{32}',task.name),'JOB_TASK_CUSTODY')
                    if value['action']=='cancel':
                        if not(task/'CANCEL.json').exists():exclusive(task/'CANCEL.json',{'requestMessageId':message,'authoritySHA256':digest(proof),'at':time.time()})
                    current=self.jobs.get(record['operationId']);result=task/'SCOPE-RESULT.json';state=current[2]if current is not None and len(current)==3 else(json.loads(private_bytes(result)).get('state')if result.exists()else'UNKNOWN_OR_RUNNING_NO_REPLAY')
                    return {'jobId':record['operationId'],'state':state,'requestMessageId':message}
                need(value['action']=='submit','NOT_FOUND');need(next(self.root.glob('request-*.json'),None)is None,'ADMITTED_ONE_SHOT_CONSUMED')
                at=proof['canonical']['source']['at'];need(type(at)in(int,float)and -5000<=time.time()*1000-at<=60000,'FRESH_REQUEST_REQUIRED')
                proof=self.authority(sid,message,proof);operation=uuid.uuid4().hex;manager=Workspaces(self.root/'tasks');task=manager.create('capture-'+operation)
                metadata=task/'.reverie-task.json';fd=os.open(metadata,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
                try:os.fchmod(fd,0o600)
                finally:os.close(fd)
                for name in('f','f/work','f/home','f/tmp','f/cache','f/config','f/runtime','f/artifacts'):(task/name).mkdir(mode=0o700)
                limits=self.policy['limits'];tools=self.policy['tools'];spec=FixedHostJobSpec(operation,'fixed-public-browser',self.policy_sha,'reverie-gpu-job-'+operation+'.scope',limits['memoryBytes'],limits['pids'],tuple(limits['cpuSet']),limits['runtimeSeconds'],limits['stopSeconds'],tools['systemctl']['path'],tools['systemctl']['sha256'],tools['node']['path'],tools['node']['sha256'],self.policy['runner']['path'],self.policy['runner']['sha256'],str(task/'f/work')).validate()
                need(self.broker.config_file is not None,'PERSISTED_BROKER_BINDING_REQUIRED');config_path=Path(self.broker.config_file).resolve(strict=True);config_raw=private_bytes(config_path)
                record={'kind':'FIXED_PUBLIC_BROWSER_JOB_INTENT','operationId':operation,'requestMessageId':message,'actor':self.policy['actor'],'task':str(task),'authority':proof,'policySHA256':self.policy_sha,'brokerConfigPath':str(config_path),'brokerConfigSHA256':hashlib.sha256(config_raw).hexdigest(),'spec':spec.metadata(),'at':time.time()}
                # Response-loss fence precedes common capacity publication and
                # all scope effects. Only a new operator-reviewed policy can
                # admit another job; inspect never dispatches.
                exclusive(index,record);exclusive(task/'JOB-INPUT.json',record)
                try:handle=self.broker.resource_reservations.begin_host_job(spec)
                except BaseException as error:
                    exclusive(task/'ADMISSION-UNCONFIRMED.json',{'state':'NO_SCOPE_STARTED_BY_THIS_ACTOR','commonFenceMayExist':True,'class':type(error).__name__,'at':time.time()});raise BrowserJobUnconfirmed('common admission unconfirmed; inspect/reconcile, no retry')from error
                self.jobs[operation]=(handle,spec)
                from .browser_job_scope import supervise
                thread=threading.Thread(target=supervise,args=(self,task,record,spec,handle),name='fixed-browser-job',daemon=True);thread.start()
                return {'jobId':operation,'state':'ACCEPTED_NOT_SCIENTIFIC_SUCCESS','requestMessageId':message}
            except (BrowserJobRefused,FileExistsError):raise
            except BaseException as error:raise BrowserJobUnconfirmed('fixed browser job response unconfirmed; inspect exact request before another attempt')from error
            finally:os.close(lock)
