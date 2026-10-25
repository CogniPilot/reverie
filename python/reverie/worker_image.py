"""Owner-only compare-and-swap of one stopped broker's image pin.

This route never pulls, loads, starts, stops or restarts anything. Plan is read
only. Apply retains exact private before bytes and a prepared receipt before the
single atomic image-token replacement. Uncertain publication is never retried or
rolled back automatically. Both images must already be loaded by exact ID.
"""
from __future__ import annotations

import fcntl
import functools
import contextvars
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid
from types import SimpleNamespace

from .worker import validate_config
from .worker_service import UNIT
from .worker_cleanup import StopBudget, run_client

IMAGE = re.compile(r'sha256:[0-9a-f]{64}')
CONTAINER = re.compile(r'[0-9a-f]{64}')
ENGINE_ID = re.compile(r'[A-Za-z0-9_.:-]{1,128}')
MAX_CONFIG = 1024 * 1024
MAX_OUTPUT = 4 * 1024 * 1024
MAX_WORKERS = 4096
_DEADLINE = contextvars.ContextVar("worker_image_deadline", default=None)
_EFFECT = contextvars.ContextVar("worker_image_effect", default=None)


def budget_left():
    deadline = _DEADLINE.get()
    left = 20.0 if deadline is None else min(20.0, deadline-time.monotonic())
    require(left>0,"operation-budget-exhausted")
    return left
SHOW_FIELDS = ('Id','LoadState','ActiveState','SubState','MainPID','ControlPID','Job')
SHOW_ARGS = ['systemctl','--user','show',UNIT,'--all','--no-pager','--property='+','.join(SHOW_FIELDS)]
INSPECT_FORMAT = ('{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}},'
                  '"running":{{json .State.Running}},"paused":{{json .State.Paused}},'
                  '"restarting":{{json .State.Restarting}},"pid":{{json .State.Pid}},'
                  '"status":{{json .State.Status}},"mounts":{{json .Mounts}}}')


class ImageRefused(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class ImageUpdateUnconfirmed(RuntimeError):
    def __init__(self, result):
        self.result = result
        super().__init__('worker-image-publication-unconfirmed')


def refuse_unknown(function):
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        previous = _DEADLINE.get()
        deadline = time.monotonic()+(120 if function.__name__=="apply" else 60)
        token = _DEADLINE.set(min(previous,deadline) if previous is not None else deadline)
        effect = {'attempted':False,'result':None} if function.__name__=='apply' else None
        effect_token = _EFFECT.set(effect)
        try:
            return function(*args, **kwargs)
        except BaseException as error:
            # Includes outer context-manager exits after the inner handler returned.
            if effect is not None and effect['attempted']:
                result={**effect['result'],'state':'unconfirmed'}
                try:args[0]._hold_unconfirmed(result)
                except BaseException:pass  # Still unknown if the private store is unavailable.
                raise ImageUpdateUnconfirmed(result) from error
            if isinstance(error,(ImageRefused,ImageUpdateUnconfirmed)):raise
            if isinstance(error,Exception):raise ImageRefused('operation-unavailable') from error
            raise
        finally:
            _EFFECT.reset(effect_token)
            _DEADLINE.reset(token)
    return wrapped


def require(value, code):
    if not value:
        raise ImageRefused(code)


def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()


def sha(data):
    return 'sha256:'+hashlib.sha256(data).hexdigest()


def strict_json(raw):
    def pairs(items):
        out = {}
        for key,value in items:
            require(key not in out,'duplicate-json-key')
            out[key] = value
        return out
    try:
        return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _: require(False,'invalid-json'))
    except (TypeError,UnicodeError,RecursionError,json.JSONDecodeError) as error:
        raise ImageRefused('invalid-json') from error


def bounded_run(args):
    """Existing bounded client engine, never an unbounded communicate/global kill."""
    owner = SimpleNamespace(owned_clients={},stopping=StopBudget(),cleanup_uncertain=set())
    result = run_client(args,timeout=budget_left(),owner=owner,limit=MAX_OUTPUT)
    require(not owner.owned_clients and not owner.cleanup_uncertain,'client-reaping-unconfirmed')
    return result


def private_info(info, uid, *, directory=False):
    if directory:
        require(stat.S_ISDIR(info.st_mode) and info.st_uid==uid and stat.S_IMODE(info.st_mode)==0o700,'private-custody-refused')
    else:
        require(stat.S_ISREG(info.st_mode) and info.st_uid==uid and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600,'private-custody-refused')


def stamp(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)


def dirstamp(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)


class PrivateConfig:
    """Hold no-follow ancestor descriptors through the final atomic publication."""
    def __init__(self,path):
        self.uid = os.getuid(); self.path = Path(path); self.fds=[]; self.links=[]; self.file=None
        require(self.path.is_absolute() and self.path.anchor=='/' and str(self.path)!='/' and '..' not in self.path.parts and self.path.resolve()==self.path and not any(ord(c)<32 or ord(c)==127 for c in str(self.path)),'canonical-config-required')
        try:
            fd = os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC); self.fds.append(fd)
            for part in self.path.parent.parts[1:]:
                parent = fd
                fd = os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
                self.fds.append(fd); info=os.fstat(fd)
                require(info.st_uid in (0,self.uid) and not info.st_mode&0o022,'private-custody-refused')
                self.links.append((parent,part,fd,dirstamp(info)))
            self.parent=fd; private_info(os.fstat(fd),self.uid,directory=True)
            self.file=os.open(self.path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd)
            self.info=os.fstat(self.file); private_info(self.info,self.uid)
            require(self.info.st_size<=MAX_CONFIG,'config-too-large')
            self.raw=self.read_fd(self.file,MAX_CONFIG); self.document=strict_json(self.raw)
            require(isinstance(self.document,dict),'invalid-config')
            self.assert_unchanged()
            parsed=validate_config(self.document)
            require(parsed==self.document,'config-drift')
            require(parsed['uid']==os.getuid() and parsed['gid']==os.getgid(),'ordinary-owner-required')
            self.assert_unchanged()
        except BaseException:
            self.close(); raise
    @staticmethod
    def read_fd(fd,limit):
        chunks=[];length=0
        while length<=limit:
            chunk=os.read(fd,min(65536,limit+1-length))
            if not chunk:break
            chunks.append(chunk);length+=len(chunk)
        require(length<=limit,'private-file-too-large')
        return b''.join(chunks)
    def parents_current(self):
        for parent,name,fd,before in self.links:
            require(dirstamp(os.fstat(fd))==before==dirstamp(os.stat(name,dir_fd=parent,follow_symlinks=False)),'config-parent-drift')
        private_info(os.fstat(self.parent),self.uid,directory=True)
    def assert_unchanged(self):
        self.parents_current(); current=os.fstat(self.file); named=os.stat(self.path.name,dir_fd=self.parent,follow_symlinks=False)
        private_info(current,self.uid); require(stamp(current)==stamp(self.info)==stamp(named),'config-drift')
    def read_name(self,name,limit):
        self.parents_current()
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=self.parent)
        try:
            before=os.fstat(fd);private_info(before,self.uid);require(before.st_size<=limit,'private-file-too-large')
            value=self.read_fd(fd,limit);after=os.fstat(fd);named=os.stat(name,dir_fd=self.parent,follow_symlinks=False)
            require(len(value)==before.st_size and stamp(before)==stamp(after)==stamp(named),'config-drift');self.parents_current();return value
        finally:os.close(fd)
    def close(self):
        if self.file is not None:os.close(self.file);self.file=None
        for fd in reversed(self.fds):os.close(fd)
        self.fds=[]
    def __enter__(self):return self
    def __exit__(self,*args):self.close()


class UpdateLock:
    def __init__(self,config):
        self.config=config;self.fd=None;self.name='.worker-image.lock'
    def __enter__(self):
        self.config.parents_current()
        self.fd=os.open(self.name,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,0o600,dir_fd=self.config.parent)
        try:
            private_info(os.fstat(self.fd),self.config.uid);require(os.fstat(self.fd).st_size==0,'lock-unrecognized')
            try:fcntl.flock(self.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError as error:raise ImageRefused('busy') from error
            self.validate();return self
        except BaseException:os.close(self.fd);self.fd=None;raise
    def validate(self):
        self.config.parents_current();before=os.fstat(self.fd);after=os.stat(self.name,dir_fd=self.config.parent,follow_symlinks=False)
        private_info(before,self.config.uid);require(before.st_size==0 and stamp(before)==stamp(after),'lock-drift')
    def __exit__(self,*args):
        if self.fd is not None:os.close(self.fd);self.fd=None


def replace_image(raw,old,new):
    """Replace only the top-level JSON image value token; preserve all other bytes."""
    value=strict_json(raw);require(isinstance(value,dict) and value.get('image')==old,'image-pin-mismatch')
    text=raw.decode('utf-8');decoder=json.JSONDecoder();pos=0
    def space(index):
        while index<len(text) and text[index] in ' \t\r\n':index+=1
        return index
    pos=space(pos);require(text[pos]=='{','invalid-config');pos+=1;span=None
    while True:
        pos=space(pos)
        if text[pos]=='}':break
        key,end=decoder.raw_decode(text,pos);require(isinstance(key,str),'invalid-config');pos=space(end);require(text[pos]==':','invalid-config');start=space(pos+1);item,end=decoder.raw_decode(text,start)
        if key=='image':require(span is None and item==old,'image-pin-mismatch');span=(start,end)
        pos=space(end)
        if text[pos]=='}':break
        require(text[pos]==',','invalid-config');pos+=1
    require(span is not None,'image-pin-mismatch')
    result=(text[:span[0]]+json.dumps(new)+text[span[1]:]).encode('utf-8')
    expected=dict(value,image=new);require(strict_json(result)==expected,'image-only-invariant')
    return result


class Audit:
    def __init__(self,config,*,create=True,allowed_transaction=None):
        self.config=config;self.fd=None
        self.name='.worker-image-'+hashlib.sha256(str(config.path).encode()).hexdigest()[:16]
        if create:
            try:os.mkdir(self.name,0o700,dir_fd=config.parent);fresh=True
            except FileExistsError:fresh=False
        else:
            try:os.stat(self.name,dir_fd=config.parent,follow_symlinks=False)
            except FileNotFoundError:return
            fresh=False
        self.fd=os.open(self.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=config.parent)
        try:
            private_info(os.fstat(self.fd),config.uid,directory=True);self.identity=dirstamp(os.fstat(self.fd))
            self.binding={'kind':'reverie.worker-image.audit','version':1,'configPathDigest':sha(str(config.path).encode()),'ownerUid':config.uid}
            if fresh:self.write('marker.json',canonical(self.binding))
            else:require(canonical(strict_json(self.read('marker.json',16384)))==canonical(self.binding),'audit-binding-mismatch')
            names=os.listdir(self.fd);require(len(names)<=4096,'audit-full');total=0
            for name in names:
                require(name=='marker.json' or re.fullmatch(r'[0-9a-f]{32}\.(?:before|prepared|committed|failed|unconfirmed)\.json',name),'audit-unrecognized')
                info=os.stat(name,dir_fd=self.fd,follow_symlinks=False);private_info(info,config.uid);require(info.st_size<=MAX_CONFIG,'audit-unrecognized');total+=info.st_size
            require(total+MAX_CONFIG+32768<=256*1024*1024 and len(names)+4<=4096,'audit-full')
            self.validate_transactions(names,allowed_transaction)
            self.validate()
            if create:os.fsync(config.parent)  # Persist audit-directory reachability before any effect.
        except BaseException:os.close(self.fd);self.fd=None;raise
    def validate_transactions(self,names,allowed_transaction):
        """A created filename never proves that a terminal receipt was durable."""
        fields={'kind','version','state','transactionId','oldImage','newImage','beforeSha256','afterSha256','engineId','unit','started'}
        def receipt(transaction,state):
            value=strict_json(self.read(transaction+'.'+state+'.json',16384))
            require(isinstance(value,dict) and set(value)==fields,'previous-update-unconfirmed')
            require(value['kind']=='reverie.worker-image.receipt' and type(value['version']) is int and value['version']==1 and value['state']==state and value['transactionId']==transaction and value['unit']==UNIT and value['started'] is False,'previous-update-unconfirmed')
            require(all(isinstance(value[key],str) and IMAGE.fullmatch(value[key]) for key in ('oldImage','newImage','beforeSha256','afterSha256')) and value['oldImage']!=value['newImage'] and isinstance(value['engineId'],str) and ENGINE_ID.fullmatch(value['engineId']),'previous-update-unconfirmed')
            return value
        try:
            transactions={name.split('.')[0] for name in names if name!='marker.json'}
            for transaction in transactions:
                terminal=[state for state in ('committed','failed','unconfirmed') if transaction+'.'+state+'.json' in names]
                if transaction+'.prepared.json' not in names:
                    require(not terminal,'previous-update-unconfirmed')
                    continue  # Backup-only crash preceded the prepared/effect boundary.
                prepared=receipt(transaction,'prepared')
                before=self.read(transaction+'.before.json',MAX_CONFIG)
                require(sha(before)==prepared['beforeSha256'] and sha(replace_image(before,prepared['oldImage'],prepared['newImage']))==prepared['afterSha256'],'previous-update-unconfirmed')
                require(len(terminal)<=1 and 'unconfirmed' not in terminal,'previous-update-unconfirmed')
                for state in terminal:
                    require(receipt(transaction,state)=={**prepared,'state':state},'previous-update-unconfirmed')
                require(bool(terminal) or transaction==allowed_transaction,'previous-update-unconfirmed')
        except (ImageRefused,OSError,ValueError,TypeError) as error:
            raise ImageRefused('previous-update-unconfirmed') from error
    def validate(self):
        self.config.parents_current();require(dirstamp(os.fstat(self.fd))==self.identity==dirstamp(os.stat(self.name,dir_fd=self.config.parent,follow_symlinks=False)),'audit-drift')
    def write(self,name,data):
        self.validate() if hasattr(self,'identity') else None
        fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,0o600,dir_fd=self.fd)
        try:
            private_info(os.fstat(fd),self.config.uid);view=memoryview(data)
            while view:
                n=os.write(fd,view);require(n>0,'audit-write-failed');view=view[n:]
            os.fsync(fd)
        finally:os.close(fd)
        os.fsync(self.fd);self.validate()
    def read(self,name,limit):
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=self.fd)
        try:
            before=os.fstat(fd);private_info(before,self.config.uid);require(before.st_size<=limit,'audit-unrecognized');raw=PrivateConfig.read_fd(fd,limit)
            require(len(raw)==before.st_size and stamp(before)==stamp(os.fstat(fd))==stamp(os.stat(name,dir_fd=self.fd,follow_symlinks=False)),'audit-drift');return raw
        finally:os.close(fd)
    def close(self):
        if self.fd is not None:os.close(self.fd);self.fd=None


class WorkerImageUpdate:
    def __init__(self,config,*,home=None,run=bounded_run):
        self.config=Path(config) if config is not None else None
        self.home=Path.home() if home is None else Path(home)
        self.run=run
    def _call(self,args,code):
        budget_left();result=self.run(args);budget_left()
        require(result.returncode==0 and isinstance(result.stdout,str) and len(result.stdout.encode())<=MAX_OUTPUT,code)
        return result.stdout
    def _hold_unconfirmed(self,result):
        """Reopen only qualified private custody after an outer context-exit fault."""
        guard=None;audit=None
        try:
            guard=PrivateConfig(self.config)
            audit=Audit(guard,allowed_transaction=result['transactionId'])
            audit.write(result['transactionId']+'.unconfirmed.json',canonical(result))
        finally:
            try:
                if audit is not None:audit.close()
            finally:
                if guard is not None:guard.close()
    def _ordinary(self,old,new):
        require(sys.platform=='linux' and os.geteuid()!=0 and os.getuid()==os.geteuid(),'ordinary-owner-required')
        require(self.config is not None,'canonical-config-required')
        require(isinstance(old,str) and IMAGE.fullmatch(old) and isinstance(new,str) and IMAGE.fullmatch(new) and old!=new,'exact-distinct-image-pins-required')
    def _inactive(self):
        raw=self._call(SHOW_ARGS,'manager-unavailable');values={}
        for line in raw.splitlines():
            key,separator,value=line.partition('=');require(separator and key in SHOW_FIELDS and key not in values,'manager-unavailable');values[key]=value
        require(set(values)==set(SHOW_FIELDS),'manager-unavailable')
        require(values['Id']==UNIT and values['LoadState']=='loaded' and values['ActiveState']=='inactive' and values['SubState']=='dead' and values['MainPID']=='0' and values['ControlPID']=='0' and values['Job'] in ('','0'),'inactive-broker-required')
    def _engine(self):
        endpoint=os.environ.get('DOCKER_HOST');context=os.environ.get('DOCKER_CONTEXT')
        if context or not endpoint:
            endpoint=strict_json(self._call(['docker','context','inspect',*([context] if context else []),'--format','{{json .Endpoints.docker.Host}}'],'engine-unavailable'))
        require(isinstance(endpoint,str) and endpoint.startswith('unix:///') and not any(ord(c)<32 or ord(c)==127 for c in endpoint),'local-engine-required')
        args=['docker','--host',endpoint]
        info=strict_json(self._call([*args,'info','--format','{{json .}}'],'engine-unavailable'))
        require(isinstance(info,dict) and info.get('OSType')=='linux' and info.get('KernelVersion')==os.uname().release and isinstance(info.get('ID'),str) and ENGINE_ID.fullmatch(info['ID']) and info.get('Name')!='docker-desktop' and 'docker desktop' not in str(info.get('OperatingSystem','')).lower(),'local-engine-required')
        return args,info['ID'],sha(endpoint.encode())
    def _loaded(self,args,image):
        value=strict_json(self._call([*args,'image','inspect','--format','{{json .Id}}',image],'loaded-image-unavailable'))
        require(value==image,'loaded-image-mismatch')
    @staticmethod
    def _outside(path,sources,*,subtree=False):
        path=Path(path).resolve()
        # Ancestor identities catch host-visible bind aliases, not only symlinks.
        protected=set()
        for node in (path,*path.parents):
            try:info=node.stat()
            except FileNotFoundError:continue
            except OSError as error:raise ImageRefused('mount-custody-unavailable') from error
            protected.add((info.st_dev,info.st_ino))
        try:own=path.stat();own_identity=(own.st_dev,own.st_ino)
        except FileNotFoundError:own_identity=None
        for source in sources:
            require(isinstance(source,(str,Path)) and Path(source).is_absolute(),'mount-inventory-unavailable')
            actual=Path(source).resolve()
            require(path!=actual and not path.is_relative_to(actual) and not (subtree and actual.is_relative_to(path)),'private-config-exposed')
            try:info=actual.stat()
            except FileNotFoundError:continue  # Configured future roots still undergo lexical checks.
            except OSError as error:raise ImageRefused('mount-custody-unavailable') from error
            require((info.st_dev,info.st_ino) not in protected,'private-config-exposed')
            if subtree and own_identity is not None:
                for node in actual.parents:
                    try:info=node.stat()
                    except OSError as error:raise ImageRefused('mount-custody-unavailable') from error
                    require((info.st_dev,info.st_ino)!=own_identity,'private-config-exposed')
    @staticmethod
    def _mount_table():
        fd=os.open('/proc/self/mountinfo',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:raw=PrivateConfig.read_fd(fd,MAX_OUTPUT)
        finally:os.close(fd)
        try:text=raw.decode('utf-8')
        except UnicodeError as error:raise ImageRefused('mount-custody-unavailable') from error
        lines=text.splitlines();require(len(lines)<=8192,'mount-custody-unavailable');points=[]
        for line in lines:
            left,separator,right=line.partition(' - ');fields=left.split();require(separator and len(fields)>=6 and len(right.split())>=3,'mount-custody-unavailable')
            point=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),fields[4])
            require(Path(point).is_absolute(),'mount-custody-unavailable');points.append(Path(point))
        return raw,points
    def _inventory(self,args,config,audit_path):
        configured=[m['source'] for m in config['mounts']]+[config[k] for k in ('stateRoot','scratchRoot','apiSocketRoot','companyRoot')]
        raw=self._call([*args,'ps','--all','--no-trunc','--format','{{.ID}}'],'inventory-unavailable')
        ids=raw.splitlines();require(len(ids)<=MAX_WORKERS and len(set(ids))==len(ids) and all(CONTAINER.fullmatch(value) for value in ids),'inventory-unavailable')
        mounted=[]
        for offset in range(0,len(ids),32):
            selected=ids[offset:offset+32]
            output=self._call([*args,'inspect','--format',INSPECT_FORMAT,*selected],'inventory-unavailable')
            rows=[strict_json(line) for line in output.splitlines()]
            require(len(rows)==len(selected),'inventory-unavailable');seen=[]
            for row in rows:
                require(isinstance(row,dict) and set(row)=={'id','name','labels','running','paused','restarting','pid','status','mounts'} and row['id'] in selected and row['id'] not in seen,'inventory-unavailable');seen.append(row['id'])
                require(isinstance(row['name'],str) and re.fullmatch(r'/?[A-Za-z0-9][A-Za-z0-9_.-]{0,254}',row['name']) and (row['labels'] is None or isinstance(row['labels'],dict)),'inventory-unavailable')
                label=(row['labels'] or {}).get('reverie.worker')
                require(label is None or (isinstance(label,str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}',label)),'inventory-unavailable')
                require(all(type(row[key]) is bool for key in ('running','paused','restarting')) and type(row['pid']) is int and row['pid']>=0 and isinstance(row['mounts'],list) and len(row['mounts'])<=128,'inventory-unavailable')
                if label==config['deployment'] or row['name'].lstrip('/').startswith(config['deployment']+'-agent-'):
                    require(not any(row[k] for k in ('running','paused','restarting')) and row['pid']==0 and row['status'] in ('created','exited','dead'),'deployment-laptops-live')
                for mount in row['mounts']:
                    require(isinstance(mount,dict) and mount.get('Type') in ('bind','volume','tmpfs'),'mount-inventory-unavailable')
                    if mount['Type']!='tmpfs':
                        source=mount.get('Source');require(isinstance(source,str) and Path(source).is_absolute(),'mount-custody-unavailable')
                        try:Path(source).stat()
                        except OSError as error:raise ImageRefused('mount-custody-unavailable') from error
                        mounted.append(source);require(len(mounted)<=8192,'mount-custody-unavailable')
            require(set(seen)==set(selected),'inventory-unavailable')
        require(len(set(mounted))<=8192,'mount-custody-unavailable')
        before,points=self._mount_table()
        # Existing nested host mounts are recursively exposed by normal bind grants.
        sources=[Path(source).resolve() for source in (*configured,*mounted)]
        expanded=set(sources)
        for point in points:
            budget_left()
            if any(point==source or point.is_relative_to(source) for source in sources):expanded.add(point)
        require(len(expanded)<=16384,'mount-custody-unavailable')
        self._outside(self.config,expanded)
        self._outside(self.config.parent/'.worker-image.lock',expanded)
        self._outside(audit_path,expanded,subtree=True)
        after,_=self._mount_table();require(before==after,'mount-custody-unavailable')
    def _snapshot(self,guard,old,new,*,allowed_transaction=None):
        guard.assert_unchanged();require(guard.document.get('image')==old,'image-pin-mismatch')
        probe=Audit(guard,create=False,allowed_transaction=allowed_transaction);probe.close();self._inactive()
        args,engine,endpoint=self._engine();self._loaded(args,old);self._loaded(args,new)
        audit_name='.worker-image-'+hashlib.sha256(str(guard.path).encode()).hexdigest()[:16]
        self._inventory(args,guard.document,guard.path.parent/audit_name);self._inactive();guard.assert_unchanged()
        value={'kind':'reverie.worker-image.plan','version':1,'unit':UNIT,'deployment':guard.document['deployment'],'oldImage':old,'newImage':new,'configSha256':sha(guard.raw),'engineId':engine,'engineEndpointDigest':endpoint,'brokerInactive':True,'runningLaptops':0}
        return {**value,'planDigest':sha(canonical(value))}
    @refuse_unknown
    def plan(self,expect_old,new_image):
        self._ordinary(expect_old,new_image)
        with PrivateConfig(self.config) as guard:return self._snapshot(guard,expect_old,new_image)
    @refuse_unknown
    def apply(self,expect_old,new_image,*,expect_config_sha256,expect_plan_digest=None):
        self._ordinary(expect_old,new_image);require(isinstance(expect_config_sha256,str) and IMAGE.fullmatch(expect_config_sha256),'config-cas-required')
        if expect_plan_digest is not None:require(isinstance(expect_plan_digest,str) and IMAGE.fullmatch(expect_plan_digest),'plan-cas-required')
        with PrivateConfig(self.config) as guard, UpdateLock(guard) as lock:
            require(sha(guard.raw)==expect_config_sha256,'config-cas-mismatch')
            plan=self._snapshot(guard,expect_old,new_image)
            if expect_plan_digest is not None:require(plan['planDigest']==expect_plan_digest,'plan-cas-mismatch')
            new_raw=replace_image(guard.raw,expect_old,new_image);transaction=uuid.uuid4().hex
            result={'kind':'reverie.worker-image.receipt','version':1,'state':'prepared','transactionId':transaction,'oldImage':expect_old,'newImage':new_image,'beforeSha256':sha(guard.raw),'afterSha256':sha(new_raw),'engineId':plan['engineId'],'unit':UNIT,'started':False}
            audit=None;temporary='.worker-image-new-'+transaction;fd=None;prepared=False;attempted=False
            try:
                audit=Audit(guard);audit.write(transaction+'.before.json',guard.raw);audit.write(transaction+'.prepared.json',canonical(result));prepared=True
                fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,0o600,dir_fd=guard.parent)
                info=os.fstat(fd);private_info(info,guard.uid);require(info.st_gid==guard.info.st_gid,'config-group-mismatch')
                view=memoryview(new_raw)
                while view:
                    written=os.write(fd,view);require(written>0,'config-write-failed');view=view[written:]
                os.fsync(fd);new_info=os.fstat(fd);os.close(fd);fd=None
                fresh=self._snapshot(guard,expect_old,new_image,allowed_transaction=transaction)
                require(fresh==plan,'runtime-drift');lock.validate();audit.validate();guard.assert_unchanged()
                budget_left();attempted=True;_EFFECT.get().update(attempted=True,result=result)
                os.replace(temporary,guard.path.name,src_dir_fd=guard.parent,dst_dir_fd=guard.parent);os.fsync(guard.parent)
                actual=guard.read_name(guard.path.name,MAX_CONFIG);require(actual==new_raw,'config-readback-mismatch')
                named=os.stat(guard.path.name,dir_fd=guard.parent,follow_symlinks=False)
                require((named.st_dev,named.st_ino)==(new_info.st_dev,new_info.st_ino) and (named.st_uid,named.st_gid,stat.S_IMODE(named.st_mode))==(guard.info.st_uid,guard.info.st_gid,stat.S_IMODE(guard.info.st_mode)),'config-readback-mismatch')
                require(validate_config(strict_json(new_raw))==strict_json(new_raw),'config-readback-mismatch')
                self._inactive();args,engine,endpoint=self._engine();require(engine==plan['engineId'] and endpoint==plan['engineEndpointDigest'],'runtime-drift');self._loaded(args,new_image);self._inventory(args,strict_json(new_raw),guard.path.parent/audit.name);lock.validate();audit.validate()
                require(guard.read_name(guard.path.name,MAX_CONFIG)==new_raw,'config-readback-mismatch')
                final_info=os.stat(guard.path.name,dir_fd=guard.parent,follow_symlinks=False)
                require((final_info.st_dev,final_info.st_ino)==(new_info.st_dev,new_info.st_ino) and (final_info.st_uid,final_info.st_gid,stat.S_IMODE(final_info.st_mode))==(guard.info.st_uid,guard.info.st_gid,stat.S_IMODE(guard.info.st_mode)),'config-readback-mismatch')
                result={**result,'state':'committed'};audit.write(transaction+'.committed.json',canonical(result));return result
            except BaseException as error:
                state='unconfirmed' if attempted else 'failed';result={**result,'state':state}
                if prepared and audit is not None:
                    try:audit.write(transaction+'.'+state+'.json',canonical(result))
                    except Exception:pass
                if attempted:raise ImageUpdateUnconfirmed(result) from error
                raise
            finally:
                cleanup_error=None
                try:
                    if fd is not None:os.close(fd)
                    try:os.unlink(temporary,dir_fd=guard.parent)
                    except FileNotFoundError:pass
                except BaseException as error:cleanup_error=error
                if cleanup_error is not None and attempted and audit is not None:
                    result={**result,'state':'unconfirmed'}
                    try:audit.write(transaction+'.unconfirmed.json',canonical(result))
                    except Exception:pass
                try:
                    if audit is not None:audit.close()
                except BaseException as error:cleanup_error=error
                if cleanup_error is not None:
                    if attempted:raise ImageUpdateUnconfirmed({**result,'state':'unconfirmed'}) from cleanup_error
                    raise cleanup_error
