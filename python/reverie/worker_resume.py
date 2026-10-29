"""Closed host-owner recovery over the existing broker socket.

No human cookie, employee identity, command, runtime recipe or RAM permit is
accepted from a caller. The registered website owns the normal CompanyWake path.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import socket
import stat
import threading
import time
import uuid
import struct

from . import worker_resource_reservations as R
from .worker_storage import read_metadata
from .worker_service_upgrade import private, stamp, sync, exclusive, encoded, digest, directory_lock
from .owner_terminal_channel import Handoff, read_proc
from .owner_terminal_ledger_service import FramedChannel
from .worker_resume_peer import ResumeWebsitePeer, host_peer

PURPOSE = 'host-worker-resume-v1'
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
SHA = re.compile(r'[a-f0-9]{64}\Z')
ACTIONS = {'worker-resume-describe','prepare-worker-resume','apply-worker-resume','worker-resume-status'}


def exact(value, keys):
    R.need(type(value) is dict and set(value) == set(keys), 'RESUME_CLOSED_SCHEMA')


def publish(path,value):
    """Bind the actual writer FD, never a name replaced after publication."""
    descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        raw=encoded(value)
        while raw:
            count=os.write(descriptor,raw);R.need(count>0,'RESUME_AUDIT_WRITE');raw=raw[count:]
        os.fsync(descriptor);info=os.fstat(descriptor)
        R.need(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and
               stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1,'RESUME_AUDIT_CUSTODY')
        identity=[info.st_dev,info.st_ino,info.st_uid,stat.S_IMODE(info.st_mode),info.st_nlink,
                  info.st_size,info.st_mtime_ns,info.st_ctime_ns]
    finally:os.close(descriptor)
    sync(path.parent);R.need(stamp(path)==identity,'RESUME_AUDIT_CHANGED')
    return identity


def recipe_digest(value):
    # RuntimeRecipe's configuration values are references/strings/booleans.
    # Refuse unsupported scalars instead of cross-language numeric coercion.
    def check(item, depth=0):
        R.need(depth <= 12, 'RESUME_RECIPE_BOUND')
        if type(item) is dict:
            R.need(len(item) <= 256 and all(type(k) is str for k in item),'RESUME_RECIPE_BOUND')
            for child in item.values():check(child,depth+1)
        else:R.need(item is None or type(item) in (str,bool),'RESUME_RECIPE_SCALAR')
    R.need(type(value) is dict and len(encoded(value)) <= 32768, 'RESUME_RECIPE_REQUIRED');check(value)
    def ordered(item):
        if type(item)is dict:return {key:ordered(item[key])for key in sorted(item,key=lambda k:k.encode('utf-16-be','surrogatepass'))}
        return item
    return digest(json.dumps(ordered(value),separators=(',',':'),ensure_ascii=True).encode())


def cohort(broker):
    company = read_metadata(broker.config['companyFile'], broker.config['uid'])
    R.need(type(company) is dict and type(company.get('employees')) is list and
           0 < len(company['employees']) <= 16, 'RESUME_COHORT_BOUND')
    rows=[]
    for employee in company['employees']:
        eid,sid=employee.get('id'),employee.get('sessionId');generation=employee.get('sessionGeneration')
        R.need(type(eid) is str and UUID.fullmatch(eid) and type(sid) is str and UUID.fullmatch(sid) and
               type(generation) is int and 0<generation<=9007199254740991, 'RESUME_CANONICAL_BINDING')
        R.need(employee.get('owner') is None or type(employee.get('owner')) is str, 'RESUME_CANONICAL_OWNER')
        R.need(type(employee.get('desiredRunning')) is bool and type(employee.get('onVacation')) is bool,
               'RESUME_EXPLICIT_INTENT_REQUIRED')
        rows.append({'employeeId':eid,'sessionId':sid,'generation':generation,
            'owner':employee.get('owner'),'desiredRunning':employee['desiredRunning'],
            'onVacation':employee['onVacation'],'migrating':bool(employee.get('bindingMigration')),
            'recipeDigest':recipe_digest(employee.get('runtimeRecipe'))})
    R.need(len({r['employeeId'] for r in rows})==len(rows) and len({r['sessionId'] for r in rows})==len(rows),
           'RESUME_DUPLICATE_BINDING')
    return sorted(rows,key=lambda row:row['employeeId'])


@contextmanager
def maintenance(broker, deployment_path):
    """Same derived maintenance inode and order as the image caller; no outer CLI lock."""
    from .worker_image import strict_json
    from .resource_actor_bootstrap import _parents, _parents_current
    path=Path(deployment_path)
    R.need(path.is_absolute() and path.resolve(strict=True)==path and path.name=='deployment.json',
           'RESUME_DEPLOYMENT_PATH')
    raw=private(path);identity=stamp(path);value=strict_json(raw)
    R.need(type(value) is dict and value.get('version')==1 and
           value.get('containerName')==broker.config['serverContainer'] and
           value.get('companyRoot')==broker.config['companyRoot'],'RESUME_DEPLOYMENT_BINDING')
    lock=path.parent/'runtime/update-state/update.lock';override=os.environ.get('REVERIE_UPDATE_STATE_DIR')
    R.need(override is None or str(Path(override))==str(lock.parent),'RESUME_MAINTENANCE_OVERRIDE')
    fd,_=R._directory(lock.parent,os.getuid());os.close(fd)
    parents=_parents([path,lock]);named=lock.lstat();key=(named.st_dev,named.st_ino)
    fd=os.open(lock,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
    def current():
        actual=os.fstat(fd);named=lock.lstat()
        R.need(stat.S_ISREG(actual.st_mode) and stat.S_IMODE(actual.st_mode)==0o600 and
               actual.st_uid==os.getuid() and actual.st_nlink==1 and
               (actual.st_dev,actual.st_ino)==key==(named.st_dev,named.st_ino),'RESUME_MAINTENANCE_CHANGED')
        _parents_current(parents);R.need(stamp(path)==identity,'RESUME_DEPLOYMENT_CHANGED')
    try:
        current();fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);current();yield current;current()
    finally:os.close(fd)


class _NativeStream(Handoff):
    def __init__(self, peer, connection, credentials):
        super().__init__(peer,timeout=120)
        self.process=peer.assert_process(credentials,'node');self.credentials=credentials
        self.pidfd=os.pidfd_open(credentials[0]);self.node=connection;self.state='CONNECTED'
        R.need(not select.select([self.pidfd],[],[],0)[0],'RESUME_NODE_ENDED')
        connection.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1)
        self.frames=FramedChannel(self);self.mutex=threading.Lock()
        connection.sendall(b'HOST_RESUME_READY\n')

    def call(self, verb, value, deadline, *, expires_at=None):
        with self.mutex:
            self.website.final_code(deadline=deadline);self.website.deadline=deadline;self.frames.deadline=deadline
            if expires_at is not None:R.need(time.time()<expires_at,'RESUME_PLAN_EXPIRED')
            nonce=str(uuid.uuid4());self.frames.send({'kind':verb,'nonce':nonce,
                'expiresAtEpochMs':int(min(time.time()+deadline-time.monotonic(),expires_at or float('inf'))*1000),**value})
            while True:
                self.frames.guard()
                R.need(time.monotonic()<deadline,'RESUME_DEADLINE')
                if not select.select([self.node],[],[],min(1,deadline-time.monotonic()))[0]:continue
                reply=self.frames.read();R.need(type(reply) is dict and reply.get('nonce')==nonce,'RESUME_REPLY_BINDING')
                if reply.get('kind')=='progress':
                    exact(reply,('kind','nonce'));continue
                exact(reply,('kind','nonce','value'));R.need(reply['kind']=='result','RESUME_REPLY_SCHEMA')
                self.website.final_code(deadline=deadline)
                R.need(time.monotonic()<deadline,'RESUME_DEADLINE');return reply['value']


class HostWorkerResume:
    def __init__(self, broker, manifest_path):
        self.broker,self.manifest_path=broker,manifest_path
        self.stream=None;self.lock=threading.RLock();self.batch=threading.Lock()

    def accept_owner(self, connection, credentials):
        """Creator credentials alone do not authorize a descriptor's later writer."""
        original=host_peer(credentials,self.broker.config['uid'])
        connection.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1)
        connection.sendall(b'HOST_RESUME_OWNER_READY\n')
        deadline=time.monotonic()+5
        def take(count):
            result=bytearray()
            while len(result)<count:
                R.need(host_peer(credentials,self.broker.config['uid'])==original,'RESUME_HOST_PEER_CHANGED')
                remaining=deadline-time.monotonic();R.need(remaining>0,'RESUME_OWNER_FRAME_DEADLINE')
                connection.settimeout(min(2,remaining))
                raw,ancillary,flags,_=connection.recvmsg(count-len(result),socket.CMSG_SPACE(12),socket.MSG_CMSG_CLOEXEC)
                for level,kind,body in ancillary:
                    if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS:
                        for offset in range(0,len(body)-3,4):os.close(struct.unpack('i',body[offset:offset+4])[0])
                R.need(raw and not flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC) and len(ancillary)==1 and
                       ancillary[0][:2]==(socket.SOL_SOCKET,socket.SCM_CREDENTIALS) and
                       len(ancillary[0][2])==12 and struct.unpack('3i',ancillary[0][2])==credentials,
                       'RESUME_FOREIGN_DESCRIPTOR_WRITER')
                result.extend(raw)
            return bytes(result)
        kind=take(1);length=struct.unpack('!I',take(4))[0]
        R.need(kind==b'C' and 0<length<=8192,'RESUME_OWNER_FRAME_BOUND')
        from .human_terminal_protocol import decode
        request=decode(take(length))
        R.need(host_peer(credentials,self.broker.config['uid'])==original,'RESUME_HOST_PEER_CHANGED')
        return self.dispatch(request,credentials)

    def register(self, connection, credentials):
        peer=ResumeWebsitePeer(self.broker,self.manifest_path,credentials)
        stream=_NativeStream(peer,connection,credentials)
        try:
            with self.lock:
                old=self.stream
                if old is not None:
                    with old.mutex:
                        ready=select.select([old.node,old.pidfd],[],[],0)[0]
                        ended=old.pidfd in ready or (old.node in ready and old.node.recv(1,socket.MSG_PEEK)==b'')
                        R.need(ended,'RESUME_WEBSITE_ALREADY_REGISTERED');old.close()
                self.stream=stream
            while not self.broker.stopping.is_set() and stream.state=='CONNECTED':
                if select.select([stream.pidfd],[],[],.5)[0]:break
        finally:
            with self.lock:
                if self.stream is stream:self.stream=None
            stream.close()

    def _stream(self):
        with self.lock:stream=self.stream
        R.need(stream is not None and stream.state=='CONNECTED','RESUME_WEBSITE_UNAVAILABLE')
        return stream

    def _gate(self):
        gate=self.broker.resource_reservations
        R.need(gate is not None,'RESUME_EXISTING_CONTROL_REQUIRED')
        return gate

    def _configuration(self):
        path=Path(self.broker.config_file)
        R.need(path.is_absolute() and path.resolve(strict=True)==path,'RESUME_CONFIG_PATH')
        before=stamp(path)
        from .worker_image import strict_json
        R.need(encoded(strict_json(private(path)))==encoded(self.broker.config) and
               stamp(path)==before,'RESUME_CONFIG_CHANGED')
        return path,before

    def _time(self,plan,deadline):
        R.need(time.monotonic()<deadline and time.time()<plan['expiresAt'],'RESUME_PLAN_EXPIRED')

    def _idle(self):
        from .worker_host_job import require_idle
        gate=self._gate()
        with gate.admission():
            require_idle(gate)
            R.need(not gate.active_operations(gate._document()),'RESUME_RESOURCE_WORK_RETAINED')

    def _root(self):
        gate=self._gate();root=gate.root/'host-resume';anchor=gate.root/'host-resume.namespace.json'
        with gate.admission():
            gate.native.custody(gate.root,R.marker(self.broker.config))
            if not os.path.lexists(root) and not os.path.lexists(anchor):
                root.mkdir(mode=0o700);sync(root.parent)
                publish(anchor,{'version':1,'purpose':PURPOSE,'directory':R._identity(root)})
            R.need(os.path.lexists(root) and os.path.lexists(anchor),'RESUME_NAMESPACE_UNCONFIRMED')
            namespace=json.loads(private(anchor));exact(namespace,('version','purpose','directory'))
            R.need(namespace['version']==1 and namespace['purpose']==PURPOSE and
                   namespace['directory']==R._identity(root),'RESUME_NAMESPACE_CHANGED')
            anchor_stamp=stamp(anchor)
            fd,_=R._directory(root,os.getuid());os.close(fd)
            gate.native.custody(root,anchor)
        R.need(R._identity(root)==namespace['directory'] and stamp(anchor)==anchor_stamp,'RESUME_NAMESPACE_CHANGED')
        return root

    def _operation(self, identifier, *, create=False):
        R.need(type(identifier) is str and UUID.fullmatch(identifier),'RESUME_OPERATION_ID')
        root=self._root();path=root/identifier
        if create:
            R.need(not os.path.lexists(root/'ACTIVE.json'),'RESUME_UNKNOWN_BATCH_RETAINED')
            self._settled_history(root)
            path.mkdir(mode=0o700);sync(root)
        fd,_=R._directory(path,os.getuid());os.close(fd)
        return root,path

    def _settled_history(self,root):
        """A missing ACTIVE after failed unlink/fsync is never a fresh permit.

        This purpose-local audit only prevents another batch. Native facts and
        current saved recipes still qualify every new request independently.
        """
        paths=list(root.iterdir());R.need(len(paths)<=256,'RESUME_HISTORY_BOUND')
        for path in paths:
            if path.name=='ACTIVE.json':continue
            R.need(UUID.fullmatch(path.name) is not None,'RESUME_HISTORY_ENTRY')
            fd,_=R._directory(path,os.getuid());os.close(fd)
            if not os.path.lexists(path/'ATTEMPT.json'):
                R.need(not os.path.lexists(path/'COMPLETE.json'),'RESUME_HISTORY_UNCONFIRMED');continue
            R.need(os.path.lexists(path/'COMPLETE.json'),'RESUME_UNKNOWN_BATCH_RETAINED')
            value=json.loads(private(path/'COMPLETE.json'))
            exact(value,('version','purpose','operationId','planDigest','resultDigest'))
            R.need(type(value['version'])is int and value['version']==1 and value['purpose']==PURPOSE and
                   value['operationId']==path.name and value['planDigest']==digest(private(path/'PLAN.json')) and
                   value['resultDigest']==digest(private(path/'RESULT.json')),'RESUME_HISTORY_UNCONFIRMED')

    def _running(self, selected):
        """Normal wake ACK alone cannot qualify a stale outer viewer."""
        from .worker_resources import effective_config, policy_digest
        from .worker_storage import storage_paths
        gate=self._gate()
        with gate.admission():
            rows=gate.native.inventory()
            found=[r for r in rows if r['Config']['Labels'].get('reverie.employee')==selected['employeeId'] and
                   r['Config']['Labels'].get('reverie.session')==selected['sessionId']]
            R.need(len(found)==1,'RESUME_NATIVE_LAPTOP_REQUIRED');row=found[0]
            resources=effective_config(self.broker.config,selected['sessionId']);labels=row['Config']['Labels']
            R.need(row['Image']==resources['image'] and labels.get('reverie.worker')==self.broker.config['deployment'] and
                   labels.get('reverie.worker-policy')==policy_digest(self.broker.config,selected['sessionId']) and
                   row['State']['Running']is True,'RESUME_NATIVE_POLICY_CHANGED')
            _,native=gate.native.limits(row)
            R.need(native['memory']==resources['memoryMiB']*1024**2 and native['tasks']==resources['pidsLimit'],
                   'RESUME_NATIVE_LIMITS_CHANGED')
            R.need(native['nanoCpus']==int(resources['cpus']*1000000000),'RESUME_NATIVE_LIMITS_CHANGED')
            paths=storage_paths(self.broker.config,selected['sessionId'])
            R.need(paths.kind=='employee' and paths.identity==selected['employeeId'],'RESUME_STORAGE_BINDING_CHANGED')
            gate.native.storage(row,paths)
            R.need(gate.native.inventory()==rows,'RESUME_NATIVE_CHANGED')
        R.need(gate.native.inventory()==rows,'RESUME_TERMINAL_NATIVE_CHANGED')

    def describe(self, deadline):
        config_path,config_stamp=self._configuration()
        stream=self._stream();before=cohort(self.broker)
        value=stream.call('describe',{'cohort':before},deadline)
        exact(value,('cohort','snapshotDigest'))
        R.need(type(value['cohort']) is list and len(value['cohort'])==len(before),'RESUME_SNAPSHOT_SCHEMA')
        for actual,expected in zip(value['cohort'],before):
            exact(actual,(*expected,'savedDigest'))
            R.need({k:actual[k]for k in expected}==expected and
                   type(actual['savedDigest']) is str and SHA.fullmatch(actual['savedDigest']),'RESUME_SNAPSHOT_CHANGED')
        R.need(value['snapshotDigest']==digest(encoded(value['cohort']).rstrip(b'\n')) and
               cohort(self.broker)==before and stamp(config_path)==config_stamp,'RESUME_SNAPSHOT_CHANGED')
        return value

    def dispatch(self, request, credentials):
        R.need(type(request) is dict and request.get('action') in ACTIONS,'RESUME_CLOSED_ACTION')
        process=host_peer(credentials,self.broker.config['uid']);end=time.monotonic()+600
        action=request['action']
        if action=='worker-resume-describe':
            exact(request,('action',));value=self.describe(min(end,time.monotonic()+60))
            host_peer(credentials,self.broker.config['uid'])
            return {'version':1,'purpose':PURPOSE,'state':'RESUME_SNAPSHOT',**value}
        if action=='worker-resume-status':
            exact(request,('action','operationId'));root,path=self._operation(request['operationId'])
            plan=json.loads(private(path/'PLAN.json'));attempt=os.path.lexists(path/'ATTEMPT.json')
            recorded=os.path.lexists(path/'RESULT.json')
            if recorded:
                value=json.loads(private(path/'RESULT.json'))
                exact(value,('version','purpose','state','operationId','planDigest','results'))
                R.need(value['purpose']==PURPOSE and value['operationId']==request['operationId'] and
                       value['planDigest']==digest(encoded(plan)) and value['state']=='RESUME_RESULTS_RECORDED',
                       'RESUME_HISTORY_UNCONFIRMED')
            return {'version':1,'purpose':PURPOSE,'operationId':request['operationId'],
                    'state':'UNKNOWN_NOT_REPLAYABLE'if attempt and os.path.lexists(root/'ACTIVE.json') else
                            'RESULT_RECORDED_NOT_REPLAYABLE'if recorded else 'UNKNOWN_NOT_REPLAYABLE'if attempt else 'PREPARED',
                    'planDigest':digest(encoded(plan)),'retryAllowed':False}
        if action=='prepare-worker-resume':
            exact(request,('action','operationId','expectedSnapshotDigest','deploymentPath'))
            R.need(type(request['expectedSnapshotDigest'])is str and SHA.fullmatch(request['expectedSnapshotDigest']),
                   'RESUME_SNAPSHOT_DIGEST')
            with maintenance(self.broker,request['deploymentPath']):
                snapshot=self.describe(min(end,time.monotonic()+60))
                R.need(snapshot['snapshotDigest']==request['expectedSnapshotDigest'],'RESUME_SNAPSHOT_CHANGED')
                root,path=self._operation(request['operationId'],create=True)
                plan={'version':1,'purpose':PURPOSE,'operationId':request['operationId'],'snapshot':snapshot,
                      'deploymentPath':request['deploymentPath'],'expiresAt':int(time.time())+300,
                      'operationIdentity':R._identity(path),'namespaceIdentity':R._identity(root)}
                plan_stamp=publish(path/'PLAN.json',plan);host_peer(credentials,self.broker.config['uid'])
            self._stream().website.final_code(deadline=end)
            R.need(host_peer(credentials,self.broker.config['uid'])==process and
                   stamp(path/'PLAN.json')==plan_stamp,'RESUME_PREPARE_CHANGED')
            return {'version':1,'purpose':PURPOSE,'state':'RESUME_PREPARED','operationId':request['operationId'],
                    'planDigest':digest(encoded(plan)),'capacityHeld':False,'nativeEffects':False}
        exact(request,('action','operationId','planDigest'))
        root,path=self._operation(request['operationId'])
        R.need(self.batch.acquire(blocking=False),'RESUME_BATCH_BUSY')
        try:
            with directory_lock(path):
                raw=private(path/'PLAN.json');plan_stamp=stamp(path/'PLAN.json');plan=json.loads(raw)
                R.need(type(request['planDigest'])is str and SHA.fullmatch(request['planDigest']) and
                       digest(raw)==request['planDigest'],'RESUME_PLAN_CHANGED')
                exact(plan,('version','purpose','operationId','snapshot','deploymentPath','expiresAt',
                            'operationIdentity','namespaceIdentity'))
                R.need(plan['version']==1 and plan['purpose']==PURPOSE and plan['operationId']==request['operationId'] and
                       type(plan['expiresAt'])is int and time.time()<plan['expiresAt'],'RESUME_PLAN_EXPIRED')
                end=min(end,time.monotonic()+plan['expiresAt']-time.time())
                config_path,config_stamp=self._configuration()
                R.need(R._identity(path)==plan['operationIdentity'] and R._identity(root)==plan['namespaceIdentity'],
                       'RESUME_OPERATION_DIRECTORY_CHANGED')
                from .resource_actor_bootstrap import _parents,_parents_current
                parents=_parents([root/'ACTIVE.json',path/'PLAN.json'])
                R.need(not os.path.lexists(path/'ATTEMPT.json'),'RESUME_NO_REPLAY')
                with maintenance(self.broker,plan['deploymentPath']) as current:
                    self._idle()
                    snapshot=self.describe(min(end,time.monotonic()+60))
                    R.need(snapshot==plan['snapshot'],'RESUME_SNAPSHOT_CHANGED')
                    R.need(host_peer(credentials,self.broker.config['uid'])==process,'RESUME_HOST_PEER_CHANGED')
                    R.need(not os.path.lexists(root/'ACTIVE.json'),'RESUME_UNKNOWN_BATCH_RETAINED')
                    self._settled_history(root)
                    R.need(stamp(path/'PLAN.json')==plan_stamp,'RESUME_PLAN_CHANGED')
                    self._time(plan,end)
                    publish(path/'ATTEMPT.json',{'purpose':PURPOSE,'planDigest':request['planDigest']})
                    self._time(plan,end)
                    fence=publish(root/'ACTIVE.json',{'purpose':PURPOSE,'operationId':request['operationId'],
                                                     'planDigest':request['planDigest']})
                    results=[]
                    for index,row in enumerate(snapshot['cohort']):
                        if not row['desiredRunning'] or row['onVacation'] or row['migrating']:continue
                        current();R.need(time.monotonic()<end,'RESUME_DEADLINE')
                        R.need(host_peer(credentials,self.broker.config['uid'])==process,'RESUME_HOST_PEER_CHANGED')
                        self._idle()
                        R.need(cohort(self.broker)==[{k:v for k,v in item.items()if k!='savedDigest'}
                            for item in snapshot['cohort']],'RESUME_COHORT_CHANGED')
                        publish(path/('STEP-'+str(index)+'.json'),row)
                        self._time(plan,end)
                        R.need(stamp(config_path)==config_stamp,'RESUME_CONFIG_CHANGED')
                        result=self._stream().call('wake',{'operationId':request['operationId'],'employee':row},
                            min(end,time.monotonic()+120),expires_at=plan['expiresAt'])
                        exact(result,('employeeId','sessionId','generation','state'))
                        R.need(all(result[k]==row[k]for k in ('employeeId','sessionId','generation')) and
                               result['state']in('awakened','already-live'),'RESUME_WAKE_UNCONFIRMED')
                        self._running(row)
                        publish(path/('ACK-'+str(index)+'.json'),result);results.append(result)
                    R.need(stamp(root/'ACTIVE.json')==fence and stamp(path/'PLAN.json')==plan_stamp,'RESUME_AUDIT_CHANGED')
                    outcome={'version':1,'purpose':PURPOSE,'state':'RESUME_RESULTS_RECORDED',
                             'operationId':request['operationId'],'planDigest':request['planDigest'],'results':results}
                    result_stamp=publish(path/'RESULT.json',outcome)
            # All operation/maintenance finalizers run while the unknown fence remains.
            for row in snapshot['cohort']:
                if row['desiredRunning'] and not row['onVacation'] and not row['migrating']:self._running(row)
            self._stream().website.final_code(deadline=end)
            company_path=Path(self.broker.config['companyFile']);company_stamp=stamp(company_path)
            R.need(cohort(self.broker)==[{k:v for k,v in item.items()if k!='savedDigest'}for item in snapshot['cohort']],
                   'RESUME_COHORT_CHANGED')
            R.need(host_peer(credentials,self.broker.config['uid'])==process and
                   stamp(root/'ACTIVE.json')==fence and stamp(path/'PLAN.json')==plan_stamp and
                   stamp(path/'RESULT.json')==result_stamp,'RESUME_TERMINAL_CHANGED')
            complete_stamp=publish(path/'COMPLETE.next.json',{'version':1,'purpose':PURPOSE,'operationId':request['operationId'],
                'planDigest':request['planDigest'],'resultDigest':digest(encoded(outcome))})
            _parents_current(parents)
            R.need(R._identity(root)==plan['namespaceIdentity'] and R._identity(path)==plan['operationIdentity'],
                   'RESUME_OPERATION_DIRECTORY_CHANGED')
            R.need(stamp(company_path)==company_stamp and stamp(config_path)==config_stamp and
                   stamp(path/'PLAN.json')==plan_stamp and stamp(path/'RESULT.json')==result_stamp and
                   stamp(path/'COMPLETE.next.json')==complete_stamp,'RESUME_TERMINAL_METADATA_CHANGED')
            R.need(stamp(root/'ACTIVE.json')==fence,'RESUME_TERMINAL_FENCE_CHANGED')
            self._time(plan,end)
            (root/'ACTIVE.json').unlink();sync(root)
            # The unlink's directory sync is itself a fallible producer. Finish
            # it before the last stat-only bracket; do not adopt changed facts.
            _parents_current(parents)
            R.need(R._identity(root)==plan['namespaceIdentity'] and R._identity(path)==plan['operationIdentity'],
                   'RESUME_OPERATION_DIRECTORY_CHANGED')
            R.need(stamp(company_path)==company_stamp and stamp(config_path)==config_stamp and
                   stamp(path/'PLAN.json')==plan_stamp and stamp(path/'RESULT.json')==result_stamp and
                   stamp(path/'COMPLETE.next.json')==complete_stamp,'RESUME_TERMINAL_METADATA_CHANGED')
            R.need(not os.path.lexists(root/'ACTIVE.json') and not os.path.lexists(path/'COMPLETE.json'),
                   'RESUME_TERMINAL_FENCE_CHANGED')
            self._time(plan,end)
            # Final completion publication is required before any later batch.
            # A crash or failure in this slot remains conservatively blocked,
            # even when ACTIVE's unlink already became visible.
            os.rename(path/'COMPLETE.next.json',path/'COMPLETE.json')
            return {**outcome,'state':'RESUME_BATCH_CONFIRMED','retryAllowed':False}
        finally:self.batch.release()
