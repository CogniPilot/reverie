"""Separate root-only, fixed-operation lease acceptance port for the host broker.

This listener never broadens the ordinary broker transport's caller allowlist.
No request can choose a command, path, source, image, duration, PID or mount.
"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import shutil
import socket
import stat
import struct
import subprocess
import threading
import time

if __package__:
    from . import acceptance_io as I
    from . import peer_artifact as Artifact
else:
    _s = importlib.util.spec_from_file_location('_lease_acceptance_io', Path(__file__).with_name('acceptance_io.py'))
    I = importlib.util.module_from_spec(_s); _s.loader.exec_module(I)
    _a=importlib.util.spec_from_file_location('_lease_peer_artifact',Path(__file__).with_name('peer_artifact.py'))
    Artifact=importlib.util.module_from_spec(_a);_a.loader.exec_module(Artifact)

METHODS = {'prepare', 'during', 'after', 'retireOwn'}


def validate_option(config):
    option = config.get('leaseAcceptance')
    if option is None:
        return None
    I.require(isinstance(option, dict) and set(option) == {'socket', 'employeeId', 'leaseSubdirectory','peerBinary'}, 'invalid lease acceptance configuration')
    I.absolute(option['socket']); I.canonical_id(option['employeeId']); I.relative(option['leaseSubdirectory']);I.absolute(option['peerBinary'])
    I.require(len(option['socket'].encode()) <= 100 and config['uid'] > 0, 'invalid acceptance socket or broker user')
    parent=Path(option['socket']).parent;state=I.absolute(config['stateRoot'])
    I.require(parent != Path(config['socket']).parent and parent.is_relative_to(state) and parent != state and not parent.is_relative_to(state/'employees'), 'lease acceptance needs its own host-control directory under broker state, outside employee storage')
    target=Path(Artifact.TARGET);source=I.absolute(option['peerBinary'])
    for grant in config.get('mounts',[]):
        destination=I.absolute(grant['destination']);selected=I.absolute(grant['source'])
        I.require(not (target.is_relative_to(destination) or destination.is_relative_to('/opt') or destination.is_relative_to('/bin')),'configured grant shadows peer executable namespace')
        I.require(not overlaps(selected,source),'configured grant aliases peer artifact')
    return option


def overlaps(a, b):
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


def worker_config(config,session):
    """Add the immutable grant ONLY to the configured current employee's policy."""
    option=validate_option(config)
    if option is None:return config
    company=I.decoded(I.read_path(config['companyFile'],uid=config['uid'],limit=1024*1024))
    selected=[row for row in company['employees'] if row.get('id')==option['employeeId']]
    I.require(len(selected)==1,'peer grant employee ambiguous')
    current=I.canonical_id(selected[0].get('sessionId'))
    result={k:v for k,v in config.items() if k!='leaseAcceptance'}
    if session==current:
        Artifact.artifact(option['peerBinary'])
        result['mounts']=[*config['mounts'],{'source':option['peerBinary'],'destination':Artifact.TARGET,'readOnly':True}]
    return result

def expected_labels(config,session):
    """Match worker_resources.effective_config and create_args hashing exactly."""
    policies=config.get('sessionResources',{})
    I.require(isinstance(policies,dict) and len(policies)<=32,'invalid current resource map')
    fields={'budgetMode','memoryMiB','pidsLimit','cpus','poolMemoryMiB','poolTasksMax'}
    for sid,policy in policies.items():
        I.canonical_id(sid);I.require(isinstance(policy,dict) and set(policy)==fields,'invalid current resource policy')
    effective={k:v for k,v in config.items() if k!='sessionResources'}
    effective.update(policies.get(session,{}))
    effective=worker_config(effective,session)
    config_hash=hashlib.sha256(json.dumps(effective,sort_keys=True).encode()).hexdigest()
    policy_hash=hashlib.sha256(json.dumps({k:v for k,v in effective.items() if k not in ('image','maintenanceSessions')},sort_keys=True).encode()).hexdigest()
    return {'workerConfigHash':config_hash,'workerPolicyHash':policy_hash}


class HelperProcess:
    """One owned auxiliary docker-exec child, independent of terminal attachments."""
    def __init__(self, process, expires):
        self.process = process
        self.expires = expires
        self.lock = threading.Lock()
        os.set_blocking(process.stdin.fileno(),False)
        os.set_blocking(process.stdout.fileno(),False)

    def _write(self, data, deadline):
        fd = self.process.stdin.fileno()
        view = memoryview(data)
        while view:
            I.require(time.monotonic() < deadline, 'helper IO deadline elapsed')
            with selectors.DefaultSelector() as selector:
                selector.register(fd, selectors.EVENT_WRITE)
                I.require(selector.select(max(0, deadline-time.monotonic())), 'helper IO deadline elapsed')
            try:written=os.write(fd,view[:4096])
            except BlockingIOError:continue
            I.require(written>0,'helper pipe closed')
            view=view[written:]

    def _read(self, count, deadline):
        data = bytearray(); fd = self.process.stdout.fileno()
        while len(data) < count:
            I.require(time.monotonic() < deadline, 'helper IO deadline elapsed')
            with selectors.DefaultSelector() as selector:
                selector.register(fd, selectors.EVENT_READ)
                I.require(selector.select(max(0, deadline-time.monotonic())), 'helper IO deadline elapsed')
            try:part = os.read(fd, count-len(data))
            except BlockingIOError:continue
            if not part:
                raise I.Unconfirmed('fixed helper exited without complete reply')
            data.extend(part)
        return bytes(data)

    def call(self, value, timeout):
        with self.lock:
            I.require(self.process.poll() is None, 'helper is not running')
            deadline = min(time.monotonic()+timeout, time.monotonic()+max(0, self.expires-time.time()))
            data = I.encoded(value)
            I.require(len(data) <= I.MAX_MESSAGE, 'helper input too large')
            self._write(struct.pack('!I', len(data))+data, deadline)
            size = struct.unpack('!I', self._read(4, deadline))[0]
            I.require(0 < size <= I.MAX_MESSAGE, 'helper reply too large')
            result = I.decoded(self._read(size, deadline))
            I.require(isinstance(result, dict) and result.get('status') != 'FAILED', 'fixed helper refused the control')
            return result

    def close(self):
        # EOF causes the fixed helper to retire only its own probes. Never signal a laptop or other job.
        try:
            self.process.stdin.close()
        except (OSError, ValueError):
            pass
        deadline=time.monotonic()+6
        while self.process.poll() is None and time.monotonic()<deadline:time.sleep(.01)
        if self.process.poll() is None:
            # An unreaped own session leader reserves this process-group identifier.
            if self.process.poll() is None:
                try: os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            end=time.monotonic()+1
            while self.process.poll() is None and time.monotonic()<end:time.sleep(.01)
            if self.process.poll() is None:
                I.OWNED_UNCONFIRMED[self.process.pid]=self.process
                raise I.Unconfirmed('owned helper client reap unconfirmed')
        self.process.stdout.close()
        return self.process.returncode == 0


class BrokerPeerBackend:
    """Fixed registry/inventory/exec adapter; no general engine interface is exposed."""
    def __init__(self, broker):
        self.broker = broker
        self.option = validate_option(broker.config)
        I.require(self.option is not None, 'lease acceptance is disabled')
        self.artifact=Artifact.artifact(self.option['peerBinary'])
        self.helper_sha=self.artifact['sha256']
        selected=shutil.which(broker.engine)
        I.require(selected is not None,'configured engine executable unavailable')
        self.engine=str(Path(selected).resolve(strict=True))
        self.deadline=time.monotonic()+15

    def begin(self,deadline):
        self.deadline=deadline

    def _engine(self, *argv):
        remaining=min(5,self.deadline-time.monotonic())
        I.require(remaining>0,'peer metadata budget elapsed')
        result=I.command([self.engine,*argv],timeout=remaining,limit=8*1024*1024)
        I.require(result.returncode==0,'fixed engine metadata operation failed')
        I.require(len(result.stdout) <= 8*1024*1024, 'engine metadata exceeds bound')
        return result.stdout

    def inspected(self):
        ids = self._engine('ps', '-aq', '--no-trunc', '--filter', 'label=reverie.worker='+self.broker.config['deployment']).split()
        I.require(len(ids) <= 256 and len(set(ids)) == len(ids) and all(len(v)==64 and all(c in 'abcdef0123456789' for c in v) for v in ids), 'ambiguous worker inventory')
        if not ids:
            return []
        fmt = '{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},"labels":{{json .Config.Labels}},"user":{{json .Config.User}},"pid":{{.State.Pid}},"running":{{.State.Running}},"readOnlyRootfs":{{.HostConfig.ReadonlyRootfs}},"privileged":{{.HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"mounts":{{json .Mounts}}}'
        rows = [I.decoded(line) for line in self._engine('inspect', '--type', 'container', '--format', fmt, *ids).splitlines()]
        I.require(len(rows)==len(ids) and {r['id'] for r in rows}==set(ids), 'incomplete worker inventory')
        return rows

    def custody(self):
        option = self.option
        control = I.absolute(option['socket']).parent
        I.require(getattr(self.broker,'config_file',None) is not None,'authoritative broker configuration path required')
        authorities=(control,I.absolute(self.broker.config_file),I.absolute(self.broker.config['companyFile']))
        for source in [Path(m['source']) for m in self.broker.config['mounts']]:
            for private in authorities:
                I.require(not any(overlaps(selected,authority) for selected in (source,source.resolve()) for authority in (private,private.resolve())), 'configured worker mount exposes acceptance control/authority')
        for row in self.inspected():
            for mount in row['mounts']:
                source = mount.get('Source')
                if mount.get('Type') == 'bind':
                    I.require(isinstance(source, str), 'worker bind source unavailable')
                    p = I.absolute(source)
                    for private in authorities:
                        I.require(not any(overlaps(selected,authority) for selected in (p,p.resolve()) for authority in (private,private.resolve())), 'actual worker mount exposes acceptance control/authority')

    def resolve(self, employee):
        config = self.broker.config
        I.require(employee == self.option['employeeId'], 'peer employee not configured')
        # Registry identity is derived from private host state, never a request SID or a historical edge.
        registration=I.peer_registry(config['companyFile'],config['uid'],employee)
        session=registration['sessionId']
        I.require(self.broker.allowed(session), 'peer is not eligible')
        rows = [r for r in self.inspected() if r.get('name') == '/'+config['deployment']+'-agent-'+session]
        I.require(len(rows)==1, 'current peer container unavailable')
        row = rows[0]; labels = row.get('labels') or {}
        hashes=expected_labels(config,session)
        I.require(labels.get('reverie.worker-config')==hashes['workerConfigHash'] and labels.get('reverie.worker-policy')==hashes['workerPolicyHash'],'running peer configuration/grants are stale')
        I.require(row.get('running') is True and type(row.get('pid')) is int and row['pid']>1 and row.get('image')==config['image'] and row.get('user')==f"{config['uid']}:{config['gid']}" and labels.get('reverie.worker')==config['deployment'] and labels.get('reverie.session')==session, 'current peer identity/image/state differs')
        mounts = {}
        for target in ('/home/agent', '/tmp'):
            matches = [m for m in row['mounts'] if m.get('Destination')==target]
            I.require(len(matches)==1 and matches[0].get('Type')=='bind' and matches[0].get('RW') is True, 'peer home/tmp bind unavailable')
            mounts[target] = str(I.absolute(matches[0]['Source']))
        expected_home = Path(config['stateRoot'])/'employees'/employee/'home'
        expected_tmp = Path(config['scratchRoot'])/'employees'/employee/'tmp'
        I.require(mounts == {'/home/agent':str(expected_home), '/tmp':str(expected_tmp)}, 'peer storage binding differs')
        I.require(os.access('/proc/'+str(row['pid'])+'/mountinfo', os.R_OK), 'peer host init PID unavailable')
        Artifact.mounted(row,self.artifact)
        return {'employeeId':employee, 'sessionId':session, 'sessionGeneration':registration['sessionGeneration'], 'containerId':row['id'], 'imageId':row['image'], 'initPid':row['pid'],
                'home':mounts['/home/agent'], 'tmp':mounts['/tmp'], 'uid':config['uid'], 'gid':config['gid'], 'helperSha256':self.helper_sha,
                'leaseSubdirectory':self.option['leaseSubdirectory'],**hashes}

    def launch(self, binding, expires):
        # Fixed nonroot exec into an EXISTING immutable container ID. No start/create/attach/restart.
        argv = [self.engine, 'exec', '-i', '--user', f"{binding['uid']}:{binding['gid']}", '--workdir', '/tmp',
                binding['containerId'], Artifact.TARGET]
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   start_new_session=True, env={'PATH':os.defpath, 'LANG':'C', 'LC_ALL':'C'})
        return HelperProcess(process, expires)


class PeerServer:
    """Optional separate listener. Root is the only accepted OS peer, unconditionally."""
    def __init__(self, backend):
        self.backend = backend
        self.path = I.absolute(backend.option['socket'])
        self.job = None
        self.unconfirmed = None
        self.guard = threading.Lock()
        self.stop = threading.Event()
        self.listener = None
        self.thread = None

    def start(self):
        self.backend.begin(time.monotonic()+15)
        self.backend.custody()
        if not self.path.parent.exists():
            outer=I.open_directory(self.path.parent.parent,uid=self.backend.broker.config['uid'])
            try:
                I.require(not os.fstat(outer).st_mode&0o077,'private broker control parent required')
                os.mkdir(self.path.parent.name,mode=0o700,dir_fd=outer)
            finally:os.close(outer)
        # Bootstrap/configuration precreates this private service-owned directory; never adopt a socket.
        directory = I.open_directory(self.path.parent, uid=self.backend.broker.config['uid'])
        try:
            I.require(not os.fstat(directory).st_mode & 0o077, 'private peer socket directory required')
            I.require(not os.path.lexists(self.path), 'acceptance socket already exists; no automatic adoption')
            I.require(not list(self.path.parent.glob('unconfirmed-*.json')),'previous peer cleanup remains unconfirmed')
            self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.listener.bind('/proc/self/fd/'+str(directory)+'/'+self.path.name)
            os.chmod(self.path.name,0o600,dir_fd=directory,follow_symlinks=False)
            self.directory_fd=os.dup(directory)
            self.socket_inode=I.inode(os.stat(self.path.name,dir_fd=directory,follow_symlinks=False))
            self.listener.listen(2); self.listener.settimeout(.25)
        finally:
            os.close(directory)
        self.thread = threading.Thread(target=self.serve, daemon=True); self.thread.start()
        return self

    def request(self, value):
        I.require(isinstance(value, dict) and value.get('version') == 1 and value.get('method') in METHODS, 'invalid peer method')
        method = value['method']
        operation_deadline=time.monotonic()+(25 if method=='prepare' else 15)
        self.backend.begin(operation_deadline)
        fields = {'version','method','attemptId','nonce'} | ({'employeeId','expiresAt'} if method=='prepare' else set())
        I.require(set(value)==fields and type(value['version']) is int, 'unexpected peer request fields')
        I.canonical_id(value['attemptId']); I.nonce(value['nonce'])
        if method == 'prepare':
            I.require(self.job is None and self.unconfirmed is None, 'another attempt is active or cleanup remains unconfirmed')
            I.canonical_id(value['employeeId'])
            expires = value['expiresAt']
            I.require(type(expires) in (int,float) and 90 <= expires-time.time() <= 600, 'invalid attempt expiry')
            self.backend.custody()
            binding = self.backend.resolve(value['employeeId'])
            helper = self.backend.launch(binding, expires)
            self.job = {'attemptId':value['attemptId'], 'nonce':value['nonce'], 'expiresAt':expires, 'binding':binding, 'helper':helper, 'state':'starting'}
            try:
                result = helper.call({'version':1,'attemptId':value['attemptId'],'nonce':value['nonce'],'expiresAt':expires,'leaseSubdirectory':binding['leaseSubdirectory']}, max(.01,operation_deadline-time.monotonic()))
                I.require(result.get('status')=='PREPARED' and result.get('attemptId')==value['attemptId'] and result.get('nonce')==value['nonce'], 'invalid prepared witness')
                I.require(self.backend.resolve(value['employeeId']) == binding, 'peer changed during prepare')
                self.job['prepared']=result
                self.job['state']='prepared'
                return {'version':1, 'binding':binding, 'result':result}
            except BaseException:
                self._close_job(self.job); self.job=None
                raise
        job = self.job
        I.require(job is not None and job['attemptId']==value['attemptId'] and job['nonce']==value['nonce'] and time.time()<job['expiresAt'], 'unknown or expired peer attempt')
        try:
            if method != 'retireOwn':
                I.require(self.backend.resolve(job['binding']['employeeId']) == job['binding'], 'peer changed during acceptance')
                I.require((job['state'],method) in (('prepared','during'),('during','after')), 'peer phase out of order')
            result = job['helper'].call(value, min(10,max(.01,operation_deadline-time.monotonic())))
            I.require(result.get('attemptId')==job['attemptId'] and result.get('nonce')==job['nonce'], 'peer attempt reply mismatch')
            expected = {'during':'REFUSED','after':'ACQUIRED','retireOwn':'RETIRED'}[method]
            I.require(result.get('status')==expected, 'peer control failed')
            job['lastPeerResult']=result
            job['state']=method
            if method=='retireOwn':
                I.require(result.get('cleanupComplete') is True, 'peer cleanup unconfirmed')
                I.require(self._close_job(job),'helper clean exit unconfirmed'); self.job=None
            return {'version':1, 'binding':job['binding'], 'result':result}
        except BaseException:
            self._close_job(job); self.job=None
            raise

    def _close_job(self,job):
        try:confirmed=job['helper'].close()
        except Exception:confirmed=False
        if not confirmed:
            self.unconfirmed={'attemptId':job['attemptId'],'nonce':job['nonce'],'binding':job['binding'],'status':'CLEANUP_UNCONFIRMED','prepared':job.get('prepared'),'lastPeerResult':job.get('lastPeerResult')}
            # Keep both evidence and owned process references; never report terminal success or auto-retry.
            try:
                directory=I.open_directory(self.path.parent,uid=self.backend.broker.config['uid'])
                try:
                    fd=os.open('unconfirmed-'+job['attemptId']+'.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=directory)
                    with os.fdopen(fd,'wb') as stream:stream.write(I.encoded(self.unconfirmed));stream.flush();os.fsync(stream.fileno())
                finally:os.close(directory)
            except OSError:pass
        return confirmed

    def serve(self):
        while not self.stop.is_set():
            if self.job is not None and time.time() >= self.job['expiresAt']:
                with self.guard:
                    if self.job is not None:
                        self._close_job(self.job); self.job=None
            try:
                connection,_ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                if self.stop.is_set(): break
                raise
            # A single bounded request is sufficient; no unbounded worker thread spawning.
            with connection:
                try:
                    I.require(I.peer_uid(connection)==0, 'root OS peer required')
                    request = I.receive_message(connection,time.monotonic()+5)
                    with self.guard:
                        result = self.request(request)
                    I.send_message(connection,{'ok':True,'value':result},time.monotonic()+5)
                except Exception:
                    try:I.send_message(connection,{'ok':False,'error':'lease acceptance request refused or unconfirmed'},time.monotonic()+1)
                    except (OSError,ValueError):pass

    def close(self):
        self.stop.set()
        if self.listener is not None:self.listener.close()
        if self.thread is not None:self.thread.join(25)
        with self.guard:
            if self.job is not None:
                self._close_job(self.job);self.job=None
        directory=getattr(self,'directory_fd',None)
        if directory is not None:
            try:
                info=os.stat(self.path.name,dir_fd=directory,follow_symlinks=False)
                if self.unconfirmed is None and stat.S_ISSOCK(info.st_mode) and info.st_uid==self.backend.broker.config['uid'] and I.inode(info)==self.socket_inode:
                    os.unlink(self.path.name,dir_fd=directory)
            except FileNotFoundError:pass
            finally:os.close(directory);self.directory_fd=None


class PeerClient:
    def __init__(self, path, broker_uid):
        self.path=I.absolute(path);self.broker_uid=broker_uid
        I.require(type(broker_uid) is int and broker_uid>0, 'nonroot trusted broker uid required')

    def call(self, request):
        parent=I.open_directory(self.path.parent,uid=self.broker_uid)
        try:
            I.require(not os.fstat(parent).st_mode&0o077,'private broker socket directory required')
            info=os.stat(self.path.name,dir_fd=parent,follow_symlinks=False)
            I.require(stat.S_ISSOCK(info.st_mode) and info.st_uid==self.broker_uid and not info.st_mode&0o077,'trusted private peer socket required')
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
                # The protected parent is pinned; /proc/self/fd addresses exactly that directory.
                connection.settimeout(5);connection.connect('/proc/self/fd/'+str(parent)+'/'+self.path.name)
                I.require(I.peer_uid(connection)==self.broker_uid,'broker OS identity differs')
                deadline=time.monotonic()+(30 if request.get('method')=='prepare' else 20)
                I.send_message(connection,request,deadline)
                reply=I.receive_message(connection,deadline)
                I.require(isinstance(reply,dict) and reply.get('ok') is True and set(reply)=={'ok','value'},'peer refused or outcome unconfirmed')
                value=reply['value']
                I.require(isinstance(value,dict) and set(value)=={'version','binding','result'} and type(value['version']) is int and value['version']==1,'peer response schema differs')
                return value
        finally:os.close(parent)
