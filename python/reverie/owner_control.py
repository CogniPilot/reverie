"""Owner-installed control bindings and conservative operation fences.

No CLI, registration side effect on reads, runtime authority, migration or reset.
Native provider completeness/authority is an external installation qualification.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import stat
import threading
from .worker_service import UNIT as WORKER_UNIT


class Refused(ValueError): pass
class Held(Refused): pass
class Unconfirmed(RuntimeError): pass

BINDING = {'resourceId','containerName','stateDirectory','deploymentPath','policyPath','maintenanceLockDirectory','generation'}
REQUEST = BINDING - {'resourceId','generation'}
FACTS = {'engineId','primaryStateDirectory','configuredBindSources','actualBindSources','workerConfigSha256','workerDeployment','workerImage'}
PHASES = {'WORKER_IN_FLIGHT','WORKER_COMMITTED','WORKER_UNCHANGED','WEBSITE_IN_FLIGHT','ADOPTED','HELD','UNCONFIRMED'}
PLAN = {'kind','version','unit','deployment','oldImage','newImage','configSha256','engineId','engineEndpointDigest','brokerInactive','runningLaptops','planDigest'}
RECEIPT = {'kind','version','state','transactionId','oldImage','newImage','beforeSha256','afterSha256','engineId','unit','started'}
CUSTODY_FIELDS = {'bindingDigest','controlPathsDigest','sourcePathsDigest','evidenceDigest'}
UNCHANGED = {'kind','version','engineId','unit','deployment','image','configSha256','parentPlanDigest'}
UNCHANGED_ADMISSION = {'bindingDigest','inputDigest','readbackDigest','evidenceDigest'}
ADOPTION_ADMISSION = {'bindingDigest','intentDigest','receiptDigest','readbackDigest','evidenceDigest'}
INTENT = {'version','operationId','name','oldId','oldImage','newImage','planDigest','controlBinding','controlGrantDigest','specPin','schemaFloors','automaticOldImageRollback','finalSpecApproval'}
WEBSITE_RECEIPT = {'version','operationId','oldId','oldImage','newImage','phase','state','newId','oldStopped','newStartAttempted','automaticOldImageRollback','schemaState','planDigest','controlBinding','controlGrantDigest','retainedOldName','backup','checkpointDigest'}
FENCE = {'version','resourceId','bindingGeneration','operationId','phase','workerPlan','workerObservation','workerReadback','receiptDigest','websiteIntent','websiteReceipt','admission','previousDigest'}
MAX_ENTRIES=4096
MAX_BINDINGS=1024
MAX_HISTORIES=1024
RESERVED_SLOTS=3


def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()
def digest(value): return 'sha256:' + hashlib.sha256(canonical(value)).hexdigest()
def custody_digests(binding,control_paths,all_sources):
    """Shared stage/provider codec; preserve list order, including Unicode paths."""
    return {'bindingDigest':digest(binding),'controlPathsDigest':digest([str(path) for path in control_paths]),'sourcePathsDigest':digest(all_sources)}
def require(ok, message):
    if not ok: raise Refused(message)
def sha(value): return isinstance(value,str) and re.fullmatch(r'sha256:[0-9a-f]{64}',value) is not None

def absolute(value):
    require(isinstance(value,str) and 0<len(value)<=4096 and len(value.encode())<=4096 and Path(value).anchor=='/' and str(Path(value))==value and '..' not in Path(value).parts and not any(ord(c)<32 or ord(c)==127 for c in value),'canonical absolute path required')
    return Path(value)

def identity(info): return [info.st_dev,info.st_ino]

def worker_readback(facts):
    return {'engineId':facts['engineId'],'unit':WORKER_UNIT,'deployment':facts['workerDeployment'],'image':facts['workerImage'],'configSha256':facts['workerConfigSha256']}

def checked_plan(value):
    require(isinstance(value,dict) and set(value)==PLAN and value['kind']=='reverie.worker-image.plan' and type(value['version']) is int and value['version']==1,'closed worker plan required')
    require(all(sha(value[k]) for k in ('oldImage','newImage','configSha256','engineEndpointDigest','planDigest')) and value['brokerInactive'] is True and type(value['runningLaptops']) is int and value['runningLaptops']==0,'worker admission unavailable')
    require(value['oldImage']!=value['newImage'],'unchanged-worker evidence port required')
    require(value['unit']==WORKER_UNIT and isinstance(value['deployment'],str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}',value['deployment']),'fixed worker unit/deployment required')
    require(isinstance(value['engineId'],str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',value['engineId']),'exact worker engine identity required')
    require(value['planDigest']==digest({k:v for k,v in value.items() if k!='planDigest'}),'worker plan digest changed')
    return json.loads(canonical(value))

def checked_intent(value,binding):
    require(isinstance(value,dict) and set(value)==INTENT and type(value['version']) is int and value['version']==1,'closed website intent required')
    require(isinstance(value['operationId'],str) and re.fullmatch(r'[0-9a-f]{32}',value['operationId']) and isinstance(value['oldId'],str) and re.fullmatch(r'[0-9a-f]{64}',value['oldId']),'exact child website identities required')
    require(sha(value['oldImage']) and sha(value['newImage']) and value['oldImage']!=value['newImage'] and all(sha(value[k]) for k in ('planDigest','controlGrantDigest','specPin')),'exact child website pins required')
    require(value['name']==binding['containerName'] and value['controlBinding']==binding and value['schemaFloors']==['GOAL','AUTH'] and value['automaticOldImageRollback'] is False and value['finalSpecApproval']=='approved','forward-only registered website intent required')
    return json.loads(canonical(value))

def checked_website_receipt(value,intent):
    require(isinstance(value,dict) and set(value)==WEBSITE_RECEIPT and type(value['version']) is int and value['version']==1,'closed adopted website receipt required')
    require(all(value[k]==intent[k] for k in ('operationId','oldId','oldImage','newImage','planDigest','controlBinding','controlGrantDigest','automaticOldImageRollback')),'website receipt/intent changed')
    require(value['phase']=='complete' and value['state']=='adopted' and value['schemaState']=='adopted-forward-only' and value['oldStopped'] is True and value['newStartAttempted'] is True,'website adoption incomplete')
    require(isinstance(value['newId'],str) and re.fullmatch(r'[0-9a-f]{64}',value['newId']) and value['newId']!=value['oldId'] and sha(value['controlGrantDigest']),'actual adopted website identity required')
    require(value['retainedOldName']==intent['name']+'-before-'+value['operationId'] and value['backup']=='website-state.private.tar' and sha(value['checkpointDigest']),'retained forward evidence required')
    return json.loads(canonical(value))

def directory(path, uid, *, private=False, create=False):
    """Pin every component. Only root-owned sticky shared ancestors are tolerated."""
    path=absolute(str(path));fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
    try:
        for component in path.parts[1:]:
            try:child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            except FileNotFoundError:
                if not create:raise
                try:os.mkdir(component,0o700,dir_fd=fd);os.fsync(fd)
                except FileExistsError:pass
                child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            info=os.fstat(child)
            safe=not info.st_mode&0o022 or (info.st_uid==0 and info.st_mode&stat.S_ISVTX)
            if not (info.st_uid in (0,uid) and safe):
                os.close(child);raise Refused('uncontrolled directory ancestor')
            os.close(fd);fd=child
        info=os.fstat(fd)
        require(info.st_uid==uid and not info.st_mode&0o022 and (not private or info.st_mode&0o777==0o700),'private owned directory required')
        return fd
    except BaseException:os.close(fd);raise

def file_info(path,uid):
    path=absolute(str(path));parent=directory(path.parent,uid)
    try:
        fd=os.open(path.name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
        try:
            info=os.fstat(fd);require(stat.S_ISREG(info.st_mode) and info.st_uid==uid and info.st_nlink==1 and info.st_mode&0o777 in (0o400,0o600),'private owned regular file required')
            return info
        finally:os.close(fd)
    finally:os.close(parent)

def read(fd,name,uid):
    child=os.open(name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
    try:
        before=os.fstat(child);require(stat.S_ISREG(before.st_mode) and before.st_uid==uid and before.st_nlink==1 and before.st_mode&0o777==0o600,'private single-link control file required')
        data=os.read(child,65537);after=os.fstat(child);named=os.stat(name,dir_fd=fd,follow_symlinks=False)
        stamp=lambda v:(v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns,v.st_ctime_ns)
        require(len(data)==before.st_size and len(data)<=65536 and stamp(before)==stamp(after)==stamp(named),'short/changed/oversized control file')
        def pairs(items):
            result={}
            for k,v in items:require(k not in result,'duplicate control key');result[k]=v
            return result
        try:return json.loads(data,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(Refused('nonfinite control value')))
        except (ValueError,UnicodeError,RecursionError) as error:raise Refused('invalid control JSON') from error
    finally:os.close(child)

def write(fd,name,value,*,exclusive=False):
    data=canonical(value);require(len(data)<=65536,'control record bound exceeded')
    temporary=name if exclusive else '.tmp-'+secrets.token_hex(16)
    child=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=fd)
    try:
        os.fchmod(child,0o600)
        with os.fdopen(child,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
        if not exclusive:os.replace(temporary,name,src_dir_fd=fd,dst_dir_fd=fd)
        os.fsync(fd)
    except BaseException:
        # Preserve partial/temporary evidence; callers must never report success.
        raise


def overlap(a,b): return a==b or a.is_relative_to(b) or b.is_relative_to(a)

def exposed(protected, sources):
    for source in sources:
        source=absolute(source);selected=(source,source.resolve())
        for path in protected:
            path=absolute(str(path));targets=(path,path.resolve())
            require(not any(overlap(a,b) for a in selected for b in targets),'control/approval path exposed through a bind source')
            # Detect physical bind aliases as well as symlink spellings.
            if source.exists():
                si=identity(source.stat())
                path_ancestors=[identity(p.stat()) for p in (path,*path.parents) if p.exists()]
                require(si not in path_ancestors,'physical control bind ancestor alias')
                if path.exists():
                    pi=identity(path.stat())
                    source_ancestors=[identity(p.stat()) for p in (source,*source.parents) if p.exists()]
                    require(pi not in source_ancestors,'physical control bind child alias')

def bounded_names(fd,limit=None):
    """Consume at most cap+1 entries; never materialize an unbounded listdir."""
    result=[]
    if limit is None:limit=MAX_ENTRIES
    with os.scandir(fd) as entries:
        for entry in entries:
            require(len(result)<limit,'registry entry bound exceeded')
            result.append(entry.name)
    return result


class OwnerControlRegistry:
    def __init__(self,provider):
        self.provider=provider;self.uid=os.geteuid()
        self._token=object()
        self.home=Path(pwd.getpwuid(self.uid).pw_dir)
        self.root=self.home/'.local/state/reverie/owner-control/v1'

    @classmethod
    def for_fixtures(cls,home,provider):
        """Owned fixture injection only; no production CLI or environment override."""
        obj=cls(provider);obj.home=absolute(str(home));obj.root=obj.home/'.local/state/reverie/owner-control/v1';return obj

    def _facts(self):
        method=getattr(self.provider,'snapshot',None)
        require(callable(method),'qualified native facts provider unavailable')
        value=method()
        require(isinstance(value,dict) and set(value)==FACTS,'closed native provider facts required')
        require(isinstance(value['engineId'],str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',value['engineId']),'actual engine identity required')
        require(sha(value['workerConfigSha256']) and sha(value['workerImage']),'trusted worker config/image readback required')
        require(isinstance(value['workerDeployment'],str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}',value['workerDeployment']),'trusted worker deployment required')
        for name in ('configuredBindSources','actualBindSources'):
            require(isinstance(value[name],list) and len(value[name])<=1024,'complete bounded bind sources required')
            for path in value[name]:absolute(path)
        return json.loads(canonical(value))

    def _proposal(self,request,facts):
        require(isinstance(request,dict) and set(request)==REQUEST,'exact website control request required')
        require(isinstance(request['containerName'],str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',request['containerName']),'invalid container name')
        primary=absolute(facts['primaryStateDirectory']);fd=directory(primary,self.uid)
        try:primary_id=identity(os.fstat(fd))
        finally:os.close(fd)
        anchors={}
        for name in ('stateDirectory','maintenanceLockDirectory'):
            path=absolute(request[name]);fd=directory(path,self.uid,private=True)
            try:anchors[name]=identity(os.fstat(fd))
            finally:os.close(fd)
        for name in ('deploymentPath','policyPath'):file_info(absolute(request[name]),self.uid)
        require(absolute(request['maintenanceLockDirectory'])==absolute(request['deploymentPath']).parent/'runtime/update-state','maintenance lock directory must match the canonical deployment root')
        control_paths=[self.root,*[absolute(request[k]) for k in ('stateDirectory','deploymentPath','policyPath','maintenanceLockDirectory')]]
        all_sources=facts['configuredBindSources']+facts['actualBindSources']
        resource='owner-'+digest({'engineId':facts['engineId'],'primaryIdentity':primary_id})[7:]
        binding={'resourceId':resource,**request}
        subject={'kind':'reverie.owner-control.binding','version':1,'binding':binding,'engineId':facts['engineId'],'primaryDirectory':{'path':str(primary),'identity':primary_id},'anchors':anchors}
        binding['generation']=digest(subject)
        require(len(canonical(subject))<=65536,'registration record bound exceeded')
        self.admit_control_custody(binding,control_paths,all_sources)
        return subject

    def admit_control_custody(self,binding,control_paths,all_sources):
        """Mandatory external qualified topology port; never synthesize an attestation."""
        paths=[str(absolute(str(path))) for path in control_paths]
        sources=[str(absolute(path)) for path in all_sources]
        require(isinstance(binding,dict) and set(binding)==BINDING,'closed binding required for custody')
        exposed([self.root,*paths],sources)
        method=getattr(self.provider,'admit_control_custody',None)
        require(callable(method),'qualified native custody provider unavailable')
        result=method(json.loads(canonical(binding)),list(paths),list(sources))
        require(isinstance(result,dict) and set(result)==CUSTODY_FIELDS and all(sha(v) for v in result.values()),'native custody attestation unavailable')
        expected=custody_digests(binding,paths,sources)
        require(all(result[key]==value for key,value in expected.items()),'stale native custody attestation')
        return dict(result)

    def _validate_record(self,record):
        require(isinstance(record,dict) and set(record)=={'kind','version','binding','engineId','primaryDirectory','anchors'} and record['kind']=='reverie.owner-control.binding' and type(record['version']) is int and record['version']==1,'invalid registered binding')
        require(isinstance(record['binding'],dict) and set(record['binding'])==BINDING,'invalid registered binding fields')
        require(isinstance(record['binding']['resourceId'],str) and re.fullmatch(r'owner-[0-9a-f]{64}',record['binding']['resourceId']),'invalid resource ID')
        primary=record['primaryDirectory'];require(isinstance(primary,dict) and set(primary)=={'path','identity'},'invalid primary directory identity')
        absolute(primary['path'])
        valid_identity=lambda value:isinstance(value,list) and len(value)==2 and all(type(v) is int and v>=0 for v in value) and value[1]>0
        require(valid_identity(primary['identity']) and isinstance(record['anchors'],dict) and set(record['anchors'])=={'stateDirectory','maintenanceLockDirectory'} and all(valid_identity(v) for v in record['anchors'].values()),'invalid directory anchors')
        generation=record['binding']['generation'];copy=json.loads(canonical(record));copy['binding'].pop('generation')
        require(sha(generation) and generation==digest(copy),'binding generation changed')
        return record

    def _scan(self,fd):
        names=bounded_names(fd)
        if any(name.startswith('.tmp-') or name=='registration.pending' for name in names):raise Held('registry publication remains unconfirmed; resolution unavailable')
        records=[]
        for name in names:
            if re.fullmatch(r'binding-owner-[0-9a-f]{64}\.json',name):
                require(len(records)<MAX_BINDINGS,'registration count bound')
                record=self._validate_record(read(fd,name,self.uid))
                require(name=='binding-'+record['binding']['resourceId']+'.json','registration filename changed')
                records.append(record)
            else:require(name=='registry.lock' or re.fullmatch(r'(?:fence-owner-[0-9a-f]{64}|history-owner-[0-9a-f]{64}-[0-9a-f]{32})\.json',name),'foreign registry entry')
        require(len(records)<=MAX_BINDINGS,'registration count bound')
        return records

    @contextmanager
    def _locked(self,*,create=False,exclusive=False):
        home=directory(self.home,self.uid);os.close(home)
        try:fd=directory(self.root,self.uid,private=True,create=create)
        except FileNotFoundError:
            yield None;return
        lock=None
        try:
            flags=(os.O_RDWR if exclusive else os.O_RDONLY)|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC
            try:lock=os.open('registry.lock',flags,dir_fd=fd)
            except FileNotFoundError:
                require(not bounded_names(fd),'nonempty registry missing lock; no automatic repair')
                if not create:
                    yield None;return
                try:lock=os.open('registry.lock',flags|os.O_CREAT|os.O_EXCL,0o600,dir_fd=fd)
                except FileExistsError:lock=os.open('registry.lock',flags,dir_fd=fd)
                else:os.fchmod(lock,0o600);os.fsync(lock);os.fsync(fd)
            valid=lambda v:stat.S_ISREG(v.st_mode) and v.st_uid==self.uid and v.st_nlink==1 and v.st_mode&0o777==0o600 and v.st_size==0
            info=os.fstat(lock);require(valid(info),'invalid registry lock')
            try:fcntl.flock(lock,(fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)|fcntl.LOCK_NB)
            except BlockingIOError as error:raise Held('owner registry busy') from error
            named=os.stat('registry.lock',dir_fd=fd,follow_symlinks=False);require(identity(named)==identity(info) and valid(named) and valid(os.fstat(lock)),'registry lock changed')
            yield fd
            try:
                current=directory(self.root,self.uid,private=True)
                try:require(identity(os.fstat(current))==identity(os.fstat(fd)),'registry directory changed')
                finally:os.close(current)
                named=os.stat('registry.lock',dir_fd=fd,follow_symlinks=False)
                require(identity(named)==identity(info) and valid(named) and valid(os.fstat(lock)),'registry lock replaced or changed')
            except (OSError,Refused) as error:raise Unconfirmed('registry name binding unconfirmed') from error
        finally:
            failures=[]
            for owned in (lock,fd):
                if owned is not None:
                    try:os.close(owned)
                    except OSError as error:failures.append(error)
            if failures:raise Unconfirmed('registry lock/directory cleanup unconfirmed') from failures[0]

    def _match(self,records,proposal):
        match=None
        for record in records:
            b=record['binding'];p=proposal['binding']
            collides=(record['primaryDirectory']['path']==proposal['primaryDirectory']['path'] or record['primaryDirectory']['identity']==proposal['primaryDirectory']['identity'] or (record['engineId']==proposal['engineId'] and b['containerName']==p['containerName']))
            if collides:
                require(record==proposal,'existing binding differs; reviewed migration required')
                require(match is None,'ambiguous registration');match=record
        return match

    def propose(self,request):
        proposal=self._proposal(request,self._facts())
        with self._locked() as fd:
            if fd is not None:self._match(self._scan(fd),proposal)
        return json.loads(canonical(proposal))

    def register(self,proposal):
        self._validate_record(proposal)
        request={k:proposal['binding'][k] for k in REQUEST};fresh=self._proposal(request,self._facts())
        require(fresh==proposal,'stale owner registration proposal')
        with self._locked(create=True,exclusive=True) as fd:
            fresh=self._proposal(request,self._facts());require(fresh==proposal,'registration facts changed')
            records=self._scan(fd);existing=self._match(records,fresh)
            if existing:return dict(existing['binding'])
            require(len(records)<MAX_BINDINGS,'registration capacity exhausted')
            # New binding, first fence/history, temporary and poison slots. No child
            # permit is issued here; begin rechecks and durably reserves its path.
            self._capacity(fd,additional=2+RESERVED_SLOTS)
            try:
                write(fd,'registration.pending',{'generation':fresh['binding']['generation']},exclusive=True)
                write(fd,'binding-'+fresh['binding']['resourceId']+'.json',fresh,exclusive=True)
                os.unlink('registration.pending',dir_fd=fd);os.fsync(fd)
            except BaseException as error:
                try:write(fd,'registration.pending',{'state':'UNCONFIRMED'},exclusive=True)
                except Exception:pass
                raise Unconfirmed('registration durability unconfirmed; resolution unavailable') from error
        return dict(fresh['binding'])

    def _load(self,fd,facts):
        records=self._scan(fd);primary=absolute(facts['primaryStateDirectory']);d=directory(primary,self.uid)
        try:key=identity(os.fstat(d))
        finally:os.close(d)
        matches=[r for r in records if r['primaryDirectory']['path']==str(primary) or r['primaryDirectory']['identity']==key]
        require(len(matches)==1,'owner registration missing or ambiguous')
        record=matches[0];request={k:record['binding'][k] for k in REQUEST};fresh=self._proposal(request,facts)
        require(record==fresh,'registered engine, directory or binding is stale; reviewed migration required')
        return record

    def load(self):
        facts=self._facts()
        with self._locked() as fd:
            require(fd is not None,'owner registration missing')
            return dict(self._load(fd,facts)['binding'])

    def _admit(self, method_name, arguments, expected, fields):
        method=getattr(self.provider,method_name,None)
        require(callable(method),'qualified native '+method_name+' provider unavailable')
        result=method(*json.loads(canonical(arguments)))
        require(isinstance(result,dict) and set(result)==fields and all(sha(v) for v in result.values()),'closed native admission required')
        require(all(result[k]==v for k,v in expected.items()),'stale native admission')
        return dict(result)

    def _unchanged(self,binding,observation,facts):
        require(isinstance(observation,dict) and set(observation)==UNCHANGED and observation['kind']=='reverie.owner-control.worker-unchanged' and type(observation['version']) is int and observation['version']==1,'closed unchanged-worker observation required')
        require(sha(observation['parentPlanDigest']),'approved parent plan digest required')
        actual=worker_readback(facts)
        require(all(observation[k]==v for k,v in actual.items()),'unchanged worker readback mismatch')
        expected={'bindingDigest':digest(binding),'inputDigest':digest(observation),'readbackDigest':digest(actual)}
        return self._admit('admit_unchanged_worker',[binding,observation,actual],expected,UNCHANGED_ADMISSION)

    def _adoption(self,binding,intent,receipt,worker,facts):
        require(worker_readback(facts)==worker,'worker readback drifted after admission')
        actual={'engineId':facts['engineId'],'newId':receipt['newId'],'newImage':receipt['newImage'],'newRunning':True,'oldId':receipt['oldId'],'oldStopped':True,'worker':worker,'bindingGeneration':binding['generation']}
        expected={'bindingDigest':digest(binding),'intentDigest':digest(intent),'receiptDigest':digest(receipt),'readbackDigest':digest(actual)}
        return self._admit('admit_website_adoption',[binding,intent,receipt],expected,ADOPTION_ADMISSION)

    def _validate_fence(self,value,binding):
        require(isinstance(value,dict) and set(value)==FENCE and type(value['version']) is int and value['version']==2,'unknown operation record')
        require(value['resourceId']==binding['resourceId'] and value['bindingGeneration']==binding['generation'] and isinstance(value['operationId'],str) and re.fullmatch(r'[0-9a-f]{32}',value['operationId']) and isinstance(value['phase'],str) and value['phase'] in PHASES,'stale operation record')
        require(value['previousDigest'] is None or sha(value['previousDigest']),'invalid history link')
        if value['workerPlan'] is not None:
            plan=checked_plan(value['workerPlan']);require(value['workerObservation'] is None,'conflicting worker evidence')
            require(plan['unit']==WORKER_UNIT,'worker unit changed')
        else:
            observation=value['workerObservation']
            require(isinstance(observation,dict) and set(observation)==UNCHANGED and observation['kind']=='reverie.owner-control.worker-unchanged' and type(observation['version']) is int and observation['version']==1 and observation['unit']==WORKER_UNIT and sha(observation['parentPlanDigest']),'unknown unchanged observation')
        if value['workerReadback'] is not None:
            worker=value['workerReadback'];require(isinstance(worker,dict) and set(worker)=={'engineId','unit','deployment','image','configSha256'} and worker['unit']==WORKER_UNIT and sha(worker['image']) and sha(worker['configSha256']),'invalid verified worker readback')
            if value['workerPlan'] is not None:
                require(worker['engineId']==plan['engineId'] and worker['deployment']==plan['deployment'] and worker['image']==plan['newImage'] and worker['configSha256']!=plan['configSha256'],'verified worker/plan changed')
            else:require(all(observation[k]==v for k,v in worker.items()),'verified unchanged worker changed')
        require(value['receiptDigest'] is None or sha(value['receiptDigest']),'invalid worker receipt digest')
        if value['websiteIntent'] is not None:checked_intent(value['websiteIntent'],binding)
        if value['phase']=='ADOPTED':
            require(value['workerReadback'] is not None and sha(value['receiptDigest']),'missing completed worker evidence')
            intent=checked_intent(value['websiteIntent'],binding);receipt=checked_website_receipt(value['websiteReceipt'],intent)
            admission=value['admission'];require(isinstance(admission,dict) and set(admission)==ADOPTION_ADMISSION and all(sha(v) for v in admission.values()),'invalid adoption admission')
            actual={'engineId':value['workerReadback']['engineId'],'newId':receipt['newId'],'newImage':receipt['newImage'],'newRunning':True,'oldId':receipt['oldId'],'oldStopped':True,'worker':value['workerReadback'],'bindingGeneration':binding['generation']}
            require(admission['bindingDigest']==digest(binding) and admission['intentDigest']==digest(intent) and admission['receiptDigest']==digest(receipt) and admission['readbackDigest']==digest(actual),'adoption history changed')
        return value

    def _histories(self,fd,binding):
        prefix='history-'+binding['resourceId']+'-'
        names=[n for n in bounded_names(fd) if n.startswith(prefix)];require(len(names)<=MAX_HISTORIES,'operation history bound exceeded')
        records=[];seen=set();children=set()
        for name in names:
            value=self._validate_fence(read(fd,name,self.uid),binding)
            require(value['phase']=='ADOPTED' and name==prefix+value['operationId']+'.json','unknown operation history')
            require(value['operationId'] not in seen and value['websiteIntent']['operationId'] not in children,'duplicate operation history')
            seen.add(value['operationId']);children.add(value['websiteIntent']['operationId']);records.append(value)
        indexed={digest(v):v for v in records};require(len(indexed)==len(records),'duplicate history digest')
        require(not seen.intersection(children),'parent/child operation identity reused')
        visited=set();previous=None
        while True:
            successors=[(h,v) for h,v in indexed.items() if v['previousDigest']==previous]
            require(len(successors)<=1,'forked operation history')
            if not successors:break
            key,_=successors[0];require(key not in visited,'cyclic operation history');visited.add(key);previous=key
        require(len(visited)==len(records),'broken operation history')
        return records,previous

    def _capacity(self,fd,*,additional):
        """Every durable nonterminal fence reserves three future namespace slots.

        This runs under the registry's exclusive lock. A different resource's
        begin/register cannot consume history/temporary/poison capacity promised to an
        operation while its child runs with the metadata lock released.
        """
        records=self._scan(fd);bindings={r['binding']['resourceId']:r['binding'] for r in records}
        names=bounded_names(fd);reserved=0
        for name in names:
            if name.startswith('fence-'):
                resource=name[len('fence-'):-len('.json')]
                require(resource in bindings,'unregistered capacity fence')
                value=self._validate_fence(read(fd,name,self.uid),bindings[resource])
                if value['phase']!='ADOPTED':reserved+=RESERVED_SLOTS
        require(len(names)+reserved+additional<=MAX_ENTRIES,'operation namespace capacity exhausted')

    def _ready(self,fd,binding,facts,new_id=None):
        histories,last=self._histories(fd,binding)
        name='fence-'+binding['resourceId']+'.json'
        try:current=self._validate_fence(read(fd,name,self.uid),binding)
        except FileNotFoundError:
            require(not histories,'history without current fence');return None,[]
        require(current['phase']=='ADOPTED','existing resource operation requires explicit future resolution')
        require(last==digest(current) and any(v==current for v in histories),'current adoption lacks durable exact history')
        require(new_id is None or all(new_id not in (v['operationId'],v['websiteIntent']['operationId']) for v in histories),'operation identity already used')
        self._adoption(binding,current['websiteIntent'],current['websiteReceipt'],current['workerReadback'],facts)
        return current,histories

    def fence(self):
        facts=self._facts()
        with self._locked() as fd:
            require(fd is not None,'owner registration missing');binding=self._load(fd,facts)['binding']
            try:current=self._validate_fence(read(fd,'fence-'+binding['resourceId']+'.json',self.uid),binding)
            except FileNotFoundError:current=None
            if current is not None and current['phase']!='ADOPTED':return {'state':'HELD','record':current,'resolutionAvailable':False}
            try:
                value,histories=self._ready(fd,binding,facts)
                return None if value is None else {'state':'ADOPTED','record':value,'historyCount':len(histories),'resolutionAvailable':False}
            except (Refused,OSError) as error:
                return {'state':'HELD','resolutionAvailable':False,'reason':'operation-or-proof-unconfirmed'}

    def _begin(self,operation_id,worker_plan=None,observation=None):
        require(isinstance(operation_id,str) and re.fullmatch(r'[0-9a-f]{32}',operation_id),'32hex operation ID required')
        worker_plan=checked_plan(worker_plan) if worker_plan is not None else None
        if observation is not None:observation=json.loads(canonical(observation))
        facts=self._facts()
        with self._locked(exclusive=True) as fd:
            require(fd is not None,'owner registration missing');binding=self._load(fd,facts)['binding'];resource=binding['resourceId']
            try:previous,histories=self._ready(fd,binding,facts,operation_id)
            except (Refused,OSError) as error:raise Held('existing resource operation/history requires future resolution') from error
            require(len(histories)<MAX_HISTORIES,'operation history capacity exhausted')
            self._capacity(fd,additional=(1 if previous is None else 0)+RESERVED_SLOTS)
            if worker_plan is not None:
                require(worker_plan['engineId']==facts['engineId'] and worker_plan['deployment']==facts['workerDeployment'] and worker_plan['oldImage']==facts['workerImage'] and worker_plan['configSha256']==facts['workerConfigSha256'],'worker plan stale')
                phase='WORKER_IN_FLIGHT';admission=None;verified=None;receipt_digest=None
            else:
                admission=self._unchanged(binding,observation,facts);phase='WORKER_UNCHANGED';verified=worker_readback(facts);receipt_digest=digest(observation)
            value={'version':2,'resourceId':resource,'bindingGeneration':binding['generation'],'operationId':operation_id,'phase':phase,'workerPlan':worker_plan,'workerObservation':observation,'workerReadback':verified,'receiptDigest':receipt_digest,'websiteIntent':None,'websiteReceipt':None,'admission':admission,'previousDigest':digest(previous) if previous else None}
            try:write(fd,'fence-'+resource+'.json',value,exclusive=previous is None)
            except BaseException as error:raise Unconfirmed('begin durability unconfirmed; no child may run') from error
        return _Operation(self,value,self._token)

    def begin(self,operation_id,worker_plan):return self._begin(operation_id,worker_plan=worker_plan)
    def begin_unchanged(self,operation_id,observation):return self._begin(operation_id,observation=observation)

    def _uncertain(self,operation_id):
        # Best-effort durable poison after outer descriptor/cleanup uncertainty.
        # Failure of storage itself remains externally UNCONFIRMED, never success.
        fd=None
        try:
            fd=directory(self.root,self.uid,private=True)
            write(fd,'.tmp-unconfirmed-'+operation_id,{'state':'UNCONFIRMED'},exclusive=True)
        except BaseException:pass
        finally:
            if fd is not None:
                try:os.close(fd)
                except OSError:pass


class _Operation:
    def __init__(self,registry,value,token):
        require(token is registry._token,'operation handles originate only from durable begin')
        self.registry=registry;self.value=value;self.owner=(os.getpid(),threading.get_ident());self.poisoned=False

    def _advance(self,phase,receipt=None,intent=None):
        require(not self.poisoned and self.owner==(os.getpid(),threading.get_ident()),'operation handle unavailable')
        registry=self.registry
        adoption_publication=False
        try:
            facts=registry._facts()
            with registry._locked(exclusive=True) as fd:
                require(fd is not None,'registry missing');binding=registry._load(fd,facts)['binding'];name='fence-'+binding['resourceId']+'.json'
                current=registry._validate_fence(read(fd,name,registry.uid),binding)
                require(current==self.value,'operation fence/binding changed')
                value={**current,'phase':phase}
                if phase=='WORKER_COMMITTED':
                    p=current['workerPlan'];require(current['phase']=='WORKER_IN_FLIGHT' and isinstance(receipt,dict) and set(receipt)==RECEIPT,'committed worker receipt required')
                    require(receipt['kind']=='reverie.worker-image.receipt' and type(receipt['version']) is int and receipt['version']==1 and receipt['state']=='committed' and receipt['started'] is False and isinstance(receipt['transactionId'],str) and re.fullmatch(r'[0-9a-f]{32}',receipt['transactionId']),'worker publication unconfirmed')
                    require(all(receipt[k]==p[k] for k in ('oldImage','newImage','engineId','unit')) and receipt['beforeSha256']==p['configSha256'] and sha(receipt['afterSha256']) and receipt['afterSha256']!=receipt['beforeSha256'],'receipt/plan mismatch')
                    require(facts['workerImage']==p['newImage'] and facts['workerDeployment']==p['deployment'] and facts['engineId']==p['engineId'] and receipt['afterSha256']==facts['workerConfigSha256'],'receipt/readback mismatch')
                    value.update(workerReadback=worker_readback(facts),receiptDigest=digest(receipt))
                elif phase=='WEBSITE_IN_FLIGHT':
                    require(current['phase'] in ('WORKER_COMMITTED','WORKER_UNCHANGED') and worker_readback(facts)==current['workerReadback'],'worker evidence or readback changed')
                    intent=checked_intent(intent,binding)
                    require(intent['operationId']!=current['operationId'],'distinct child website operation required')
                    histories,_=registry._histories(fd,binding)
                    require(all(intent['operationId'] not in (v['operationId'],v['websiteIntent']['operationId']) for v in histories),'child operation identity already used')
                    if current['previousDigest'] is not None:
                        prior=next((v for v in histories if digest(v)==current['previousDigest']),None)
                        require(prior is not None and intent['oldId']==prior['websiteReceipt']['newId'] and intent['oldImage']==prior['websiteReceipt']['newImage'],'website intent does not continue adopted identity')
                    if current['phase']=='WORKER_UNCHANGED':registry._unchanged(binding,current['workerObservation'],facts)
                    value['websiteIntent']=intent
                elif phase=='ADOPTED':
                    require(current['phase']=='WEBSITE_IN_FLIGHT','website effects were not admitted')
                    receipt=checked_website_receipt(receipt,current['websiteIntent'])
                    admission=registry._adoption(binding,current['websiteIntent'],receipt,current['workerReadback'],facts)
                    value.update(websiteReceipt=receipt,admission=admission)
                    registry._validate_fence(value,binding)
                    adoption_publication=True
                    write(fd,'history-'+binding['resourceId']+'-'+current['operationId']+'.json',value,exclusive=True)
                else:require(phase in ('HELD','UNCONFIRMED') and current['phase']!='ADOPTED','unsupported operation phase')
                write(fd,name,value);self.value=value
            return json.loads(canonical(value))
        except BaseException as error:
            self.poisoned=True
            if adoption_publication:registry._uncertain(self.value['operationId'])
            raise Unconfirmed('operation held; no automatic continuation or retry') from error

    def worker_committed(self,receipt):return self._advance('WORKER_COMMITTED',receipt)
    def website_in_flight(self,intent):return self._advance('WEBSITE_IN_FLIGHT',intent=intent)
    def website_adopted(self,receipt):return self._advance('ADOPTED',receipt)
    def hold(self):return self._advance('HELD')
