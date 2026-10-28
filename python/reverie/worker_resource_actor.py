"""Fixed resource-purpose broker connection and current-owner rendezvous.

The private bootstrap is installed explicitly while inactive. No directory,
policy, authority or journal is created by loading it. Browser bodies never
provide a process, engine command, observer, owner flag or effect handle.
"""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import select
import socket
import stat
import struct
import threading
import time
import uuid

from . import laptop_resource_operations as J
from . import worker_resource_reservations as R
from .goal_private import private_entry
from .owner_terminal_channel import Handoff, WebsitePeer, Program, read_proc
from .owner_terminal_ledger_service import FramedChannel
from .owner_terminal_ledger_service import encoded
from .worker_storage import read_metadata
from .worker_resource_preparation import ResourcePreparationOwner

PURPOSE = 'resource-replacement-v1'
MAX_FRAMES = 2048
MAX_CHALLENGES = 256
_MINT = object()


def exact(value, names):
    R.need(type(value) is dict and set(value) == set(names), 'RESOURCE_ACTOR_CLOSED_FRAME')


def _wire_result(verb,value):
    """Closed purpose-local metadata, never raw native receipt authority.

    Keep private persisted receipts unchanged. In particular, native inode
    counters need not fit JavaScript integers and must not cross this boundary.
    The one permitted floating field is bounded resource cpus; Python's 1.0
    and JavaScript's 1 denote the same policy but have different JSON spelling.
    """
    if verb=='draft':
        from .worker_resources import validate_resources
        exact(value,('draftId','operationId','reservationId','targetSid','profileVersion','profileDigest',
                     'previewDigest','resources','sourceMemoryMiB','capacityHeld','nativeEffects'))
        result=copy.deepcopy(value);validate_resources(result['resources'])
        cpus=result['resources']['cpus']
        if type(cpus) is float and cpus.is_integer():result['resources']['cpus']=int(cpus)
        return result
    fields={
        'claim':('reference','sessionId','state','publicationIntentDigest'),
        'publication':('state','verified','retryAllowed'),
        'prepare':('state','operationId','reservationId','profileDigest'),
        'source-stop':('state','operationId','capacityRetained','retryAllowed','verified'),
        'start':('state','operationId','reservationId','capacityRetained'),
        'verify':('state','operationId','reservationId','capacityRetained'),
        'finalize':('state','operationId','capacityRetained','retryAllowed'),
        'completion':('state','operationId','reservationId','employeeId','targetSid','profileVersion',
                      'profileDigest','previewDigest','settlementDigest','currentBindingDigest','readOnly'),
    }
    R.need(verb in fields and type(value) is dict,'RESOURCE_ACTOR_CLOSED_RESULT')
    return {name:copy.deepcopy(value[name]) for name in fields[verb]}


def _program(value, prefix=False):
    exact(value, ('executable', 'argv'))
    R.need(type(value['argv']) is list and 2 <= len(value['argv']) <= 32 and
           all(type(item) is str and 0 < len(item) <= 16384 and '\0' not in item for item in value['argv']),
           'RESOURCE_ACTOR_FIXED_PROGRAM')
    path=Path(value['executable'])
    R.need(type(value['executable']) is str and str(path).startswith('/nix/store/') and
           path.resolve(strict=True)==path,'RESOURCE_ACTOR_FIXED_PROGRAM')
    info=path.stat()
    R.need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_mode & 0o222==0,
           'RESOURCE_ACTOR_FIXED_PROGRAM')
    if prefix:
        R.need(value['argv'][-1]=='client' and value['argv'][1:3]==['-I','-B'] and
               len(value['argv'])==5 and value['argv'][3].startswith('/nix/store/') and
               Path(value['argv'][3]).resolve(strict=True)==Path(value['argv'][3]),
               'RESOURCE_ACTOR_ISOLATED_CLIENT_REQUIRED')
    return Program(str(path),tuple(value['argv']))


def _client_program(pair):
    """Consume only the immutable package's generated client manifest."""
    exact(pair,('path','sha256'));J.digest(pair['sha256'])
    path=Path(pair['path'])
    R.need(str(path).startswith('/nix/store/') and path.resolve(strict=True)==path,
           'RESOURCE_ACTOR_CLIENT_MANIFEST_REQUIRED')
    info=path.stat()
    R.need(0<info.st_size<=8192 and stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_mode&0o222==0,
           'RESOURCE_ACTOR_CLIENT_MANIFEST_CHANGED')
    raw=path.read_bytes()
    R.need(len(raw)==info.st_size and
           hashlib.sha256(raw).hexdigest()==pair['sha256'],'RESOURCE_ACTOR_CLIENT_MANIFEST_CHANGED')
    document=json.loads(raw)
    exact(document,('version','purpose','pythonInvocation','pythonExecutable','entry','entrySHA256','argvPrefix'))
    J.digest(document['entrySHA256'])
    R.need(document['version']==1 and document['purpose']=='resource-replacement-client-v1' and
           document['argvPrefix']==[document['pythonInvocation'],'-I','-B',document['entry'],'client'],
           'RESOURCE_ACTOR_CLIENT_MANIFEST_CHANGED')
    for name in ('pythonInvocation','entry'):
        value=Path(document[name]);R.need(str(value).startswith('/nix/store/') and value.is_file(),
                                         'RESOURCE_ACTOR_CLIENT_MANIFEST_CHANGED')
    entry=Path(document['entry']);entry_info=entry.stat()
    R.need(entry.resolve(strict=True)==entry and entry_info.st_uid==0 and entry_info.st_mode&0o222==0 and
           entry_info.st_size<=1024*1024 and hashlib.sha256(entry.read_bytes()).hexdigest()==document['entrySHA256'],
           'RESOURCE_ACTOR_CLIENT_MANIFEST_CHANGED')
    R.need(Path(document['pythonInvocation']).resolve(strict=True)==Path(document['pythonExecutable']),
           'RESOURCE_ACTOR_CLIENT_MANIFEST_CHANGED')
    return _program({'executable':document['pythonExecutable'],'argv':document['argvPrefix']},True)


class ResourceActorBootstrap:
    """Existing host-private full website/program facts, never owner approval."""
    def __init__(self, broker):
        from .resource_actor_install import InstalledFacts
        proof = InstalledFacts(broker, broker.resource_reservations)
        self.proof = proof
        self.broker, self.gate, self.path = broker, proof.gate, proof.path
        self.website, self.client = proof.website, proof.client
        self.document, self.signature, self.raw = proof.value, proof.signature, proof.raw
        self.parents={path:self._directory_stamp(path) for path in self.path.parents}

    def guard(self):
        self.proof.guard()
        self.assert_metadata()

    @staticmethod
    def _directory_stamp(path):
        info=path.lstat()
        R.need(stat.S_ISDIR(info.st_mode),'RESOURCE_ACTOR_FACTS_CHANGED')
        return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)

    def assert_metadata(self):
        """No native I/O after a phase's final native bracket."""
        from .goal_private import fingerprint
        from .resource_actor_install import _no_pending
        _no_pending(self.gate)
        info=self.path.lstat()
        R.need(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode)==0o600 and
               info.st_uid==self.broker.config['uid'] and info.st_nlink==1 and
               fingerprint(info)==self.signature and
               self.broker.config.get('resourceActorConfig')==str(self.path),'RESOURCE_ACTOR_FACTS_CHANGED')
        for path,stamp in self.parents.items():
            R.need(self._directory_stamp(path)==stamp,'RESOURCE_ACTOR_FACTS_CHANGED')


class _PurposeHandoff(Handoff):
    """Direct Node peer proof on the existing socket, for THIS purpose only.
    Goal's independent bootstrap->exec state machine is unchanged.
    """
    def __init__(self,bootstrap,connection,credentials):
        R.need(type(bootstrap) is ResourceActorBootstrap,'RESOURCE_ACTOR_FIXED_BOOTSTRAP_REQUIRED')
        super().__init__(bootstrap.website)
        try:
            bootstrap.guard()
            self.process=self.website.assert_process(credentials,'node')
            self.pidfd=os.pidfd_open(credentials[0])
            R.need(not select.select([self.pidfd],[],[],0)[0],'RESOURCE_ACTOR_PEER_ENDED')
            connection.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1)
            self.credentials=credentials;self.node=connection;self.state='CONNECTED'
            connection.sendall(b'RESOURCE_READY\n')
        except BaseException:self.close();raise


class _OwnerOperation:
    """Registered current-cookie challenge producer; no callback/JSON mint."""
    def __init__(self,token,connection,employee_id,approval):
        R.need(token is _MINT and type(connection) is _Connection,'RESOURCE_ACTOR_OWNER_CONTEXT_REQUIRED')
        self.connection,self.employee_id,self.approval=connection,employee_id,copy.deepcopy(approval)
        self.scope=None;self.expires=None;self.owner=None
    def assert_current(self):
        self.connection.bootstrap.guard()
        response=self.connection.challenge(self)
        signature=(response['ownerScopeDigest'],response['expiresAtEpochMs'],response['owner'])
        if self.scope is None:self.scope,self.expires,self.owner=signature
        R.need(signature==(self.scope,self.expires,self.owner),'RESOURCE_ACTOR_OWNER_CHANGED')
        self.assert_live()
    def assert_live(self):
        c=self.connection
        c.bootstrap.assert_metadata()
        R.need(not c.closed.is_set() and self.expires is not None and
               0<self.expires-int(time.time()*1000)<=300000 and
               not select.select([c.wire.channel.pidfd],[],[],0)[0], 'RESOURCE_ACTOR_OWNER_ENDED')
        # Logout closes the actual account-tracked Node socket. No blocking
        # engine/kernel producer follows this adjacent cancellation observation.
        if select.select([c.wire.channel.node],[],[],0)[0]:
            R.need(c.wire.channel.node.recv(1,socket.MSG_PEEK|socket.MSG_DONTWAIT)!=b'',
                   'RESOURCE_ACTOR_OWNER_ENDED')


def _plan_record(connection,selected,stage):
    """Fixed normal PlanMoves journal, independently read on the host.
    The current owner channel does not get to assert a boolean stop/commit.
    """
    claim=connection.owner._current(selected['key']);profile=claim['lease'].context['profile']
    path=Path(connection.broker.config['companyFile']).with_name('plan-moves.json')
    rows=read_metadata(path,connection.broker.config['uid'],limit=1024*1024)
    R.need(type(rows) is list and len(rows)<=100 and all(type(row) is dict for row in rows),
           'RESOURCE_ACTOR_PLAN_JOURNAL_REQUIRED')
    approval=selected['approval'];chosen=[row for row in rows if row.get('id')==approval['operationId']]
    R.need(len(chosen)==1 and len({row.get('id') for row in rows})==len(rows),
           'RESOURCE_ACTOR_PLAN_JOURNAL_REQUIRED')
    record=chosen[0];intent=record.get('resourceIntent')
    R.need(type(intent) is dict and set(intent)=={'operationId','reservationId','profileVersion','profileDigest','previewDigest'} and
           all(intent[field]==approval[field] for field in intent) and
           record.get('employeeId')==approval['employeeId'] and record.get('newSession')==approval['targetSid'] and
           record.get('oldSession')==profile['binding']['current_sid'] and
           record.get('owner')==selected['authority'].owner and
           record.get('resourceOwnerScope')==selected['authority'].scope and
           record.get('purpose')=='runtime-refresh' and
           type(record.get('fromAccount')) is str and 0<len(record['fromAccount'])<=100 and
           record.get('toAccount')==record['fromAccount'] and record.get('sourceStopRequested') is True,
           'RESOURCE_ACTOR_PLAN_BINDING_CHANGED')
    for field in ('requestDigest','runtimeDigest'):J.digest(record.get(field))
    stable={key:copy.deepcopy(record.get(key)) for key in ('id','owner','employeeId','oldSession','newSession',
        'fromAccount','toAccount','purpose','runtimeDigest','requestDigest','resourceIntent','resourceOwnerScope')}
    if 'plan_binding' in selected:
        R.need(stable==selected['plan_binding'],'RESOURCE_ACTOR_PLAN_BINDING_CHANGED')
    else:selected['plan_binding']=stable
    expected={'stop':('stopping','prepared'), 'start':('starting','prepared'),
              'verify':('checking','verifying'),'finalize':('completed','verified')}
    R.need(stage in expected and (record.get('phase'),record.get('resourcePhase'))==expected[stage] and
           (stage=='stop' and record.get('sourceCleanupVerified') is not True or
            stage!='stop' and record.get('sourceCleanupVerified') is True),
           'RESOURCE_ACTOR_DURABLE_PLAN_PHASE_REQUIRED')
    return copy.deepcopy(record)


def _plan_current(claim):
    context=claim.get('plan_context')
    if context is not None:
        connection,selected,stage,expected=context
        R.need(type(connection) is _Connection and connection.owner._claims.get(selected['key']) is claim,
               'RESOURCE_ACTOR_PLAN_CONTEXT_REQUIRED')
        # Avoid _current -> authority/native I/O in a terminal metadata guard.
        path=Path(connection.broker.config['companyFile']).with_name('plan-moves.json')
        rows=read_metadata(path,connection.broker.config['uid'],limit=1024*1024)
        R.need(type(rows) is list and len(rows)<=100 and
               [row for row in rows if type(row) is dict and row.get('id')==expected['id']]==[expected],
               'RESOURCE_ACTOR_PLAN_CHANGED')


class _ReadinessProof:
    def __init__(self,token,connection,selected,stage,proof,record):
        R.need(token is _MINT and type(connection) is _Connection and stage in ('verify','finalize'),
               'RESOURCE_ACTOR_READINESS_PRODUCER_REQUIRED')
        self.connection,self.selected,self.stage=connection,selected,stage
        self.proof,self.record=copy.deepcopy(proof),copy.deepcopy(record)
    def assert_current(self):
        proof,record=self.connection.check_readiness(self.selected,self.stage)
        R.need(proof==self.proof and record==self.record,'RESOURCE_ACTOR_READINESS_CHANGED')


class ResourceActorService:
    """One fixed installed broker adapter; never registered by browser JSON."""
    def __init__(self,broker):
        # Facts belong to one protected connection, not Broker construction.
        # An ended website incarnation must refuse this purpose while leaving
        # ordinary phone/recovery/J transport available. No facts are created.
        self.broker=broker
        self._lock=threading.RLock();self._launches={}
    def accept(self,connection,credentials):
        bootstrap=ResourceActorBootstrap(self.broker)
        selected=_Connection(self,connection,credentials,bootstrap)
        try:selected.serve()
        finally:selected.close()
    def resolve_launch(self,reference,request,credentials):
        J.canonical_uuid(reference)
        with self._lock:
            selected=self._launches.get(reference)
            R.need(selected is not None,'RESOURCE_ACTOR_LAUNCH_UNAVAILABLE')
            connection,key,authority=selected
            R.need(not connection.closed.is_set(),'RESOURCE_ACTOR_LAUNCH_UNAVAILABLE')
            claim=connection.owner._current(key)
            R.need(not claim.get('canonical_request_received'),'RESOURCE_ACTOR_LAUNCH_ALREADY_ATTEMPTED')
            claim['canonical_request_received']=True
        bootstrap=connection.bootstrap
        bootstrap.guard()
        prefix=bootstrap.client.argv
        argv=prefix+('--resource-ref',reference,'--session-id',request['sessionId'],
                     '--cwd',request['cwd'],'--command',request['command'])
        website=bootstrap.website.with_bootstrap(Program(bootstrap.client.executable,argv))
        website.assert_process(credentials,'bootstrap')
        authority.assert_current()
        connection.command_check(authority,request)
        from .worker_resource_native import bind_launch
        launch=bind_launch(connection.owner,key,request)
        authority.assert_live();return launch


class _Connection:
    def __init__(self,service,connection,credentials,bootstrap):
        self.service,self.broker=service,service.broker
        R.need(type(bootstrap) is ResourceActorBootstrap and bootstrap.broker is self.broker,
               'RESOURCE_ACTOR_FIXED_BOOTSTRAP_REQUIRED')
        self.bootstrap=bootstrap
        self.wire=FramedChannel(_PurposeHandoff(bootstrap,connection,credentials))
        self.owner=ResourcePreparationOwner(self.broker)
        self.closed=threading.Event();self.lock=threading.RLock();self.writer=threading.Lock()
        self.waiters={};self.claims={};self.action=None;self.action_thread=None
        self.frames=0;self.deadline=time.monotonic()+300
    def close(self):
        if self.closed.is_set():return
        self.closed.set();self.wire.close()
        with self.lock:
            for item in self.waiters.values():item['event'].set()
        # A pending action owns the claim until it exits; no asynchronous store
        # close, target stop, config restore, lease release or capacity credit.
        if self.action_thread is None or not self.action_thread.is_alive():self.owner.close()
    def send(self,value):
        with self.writer:
            R.need(not self.closed.is_set() and time.monotonic()<self.deadline,'RESOURCE_ACTOR_CHANNEL_EXPIRED')
            self.wire.deadline=min(self.deadline,time.monotonic()+5);self.wire.send(value)
    def finish_reply(self,value):
        """No late engine/native producer after the phase's terminal facts.

        Keep the reader behind the same lock until the result is written and
        this action is retired. The next request cannot race a late finalizer.
        """
        with self.lock,self.writer:
            R.need(self.action is not None and value['requestId']==self.action['requestId'] and
                   not self.closed.is_set() and time.monotonic()<self.deadline and not self.waiters and
                   not select.select([self.wire.channel.pidfd],[],[],0)[0], 'RESOURCE_ACTOR_CHANNEL_EXPIRED')
            R.need(read_proc(self.wire.channel.credentials[0])==self.wire.channel.process,
                   'RESOURCE_ACTOR_NODE_CHANGED')
            raw=encoded(value);self.wire.channel.node.settimeout(max(.001,min(2,self.deadline-time.monotonic())))
            self.wire.channel.node.sendall(struct.pack('!I',len(raw))+raw)
            self.action=None
    def exchange(self,request):
        nonce=request['nonce'];waiter={'event':threading.Event(),'reply':None}
        with self.lock:
            R.need(len(self.waiters)<8,'RESOURCE_ACTOR_CHALLENGE_BOUND');self.waiters[nonce]=waiter
        try:
            self.send(request)
            R.need(waiter['event'].wait(max(0,min(5,self.deadline-time.monotonic()))) and
                   waiter['reply'] is not None and not self.closed.is_set(),'RESOURCE_ACTOR_CURRENT_OWNER_UNAVAILABLE')
            return waiter['reply']
        finally:
            with self.lock:self.waiters.pop(nonce,None)
    def challenge(self,authority):
        with self.lock:
            action=self.action
            R.need(action is not None,'RESOURCE_ACTOR_ACTIVE_OPERATION_REQUIRED')
            action['checks']+=1;R.need(action['checks']<=MAX_CHALLENGES,'RESOURCE_ACTOR_CHALLENGE_BOUND')
            identifier=action['requestId']
        stage='preview' if authority.approval is None else 'apply'
        nonce=str(uuid.uuid4())
        request={'kind':'resource-owner-check','requestId':identifier,'nonce':nonce,'stage':stage,
                 'employeeId':authority.employee_id,'approval':authority.approval}
        response=self.exchange(request)
        exact(response,('kind','requestId','nonce','purpose','stage','owner','ownerScopeDigest',
                        'expiresAtEpochMs','approval'))
        R.need(response['kind']=='resource-owner-current' and response['requestId']==identifier and
               response['nonce']==nonce and response['purpose']==PURPOSE and response['stage']==stage and
               response['approval']==authority.approval,'RESOURCE_ACTOR_OWNER_BINDING_CHANGED')
        J.digest(response['ownerScopeDigest'])
        R.need(type(response['expiresAtEpochMs']) is int and
               0<response['expiresAtEpochMs']-int(time.time()*1000)<=300000 and
               (response['owner'] is None or type(response['owner']) is str and len(response['owner'])<=200),
               'RESOURCE_ACTOR_OWNER_EXPIRED')
        company=read_metadata(self.broker.config['companyFile'],self.broker.config['uid'])
        employee=[row for row in company['employees'] if row.get('id')==authority.employee_id]
        R.need(len(employee)==1 and employee[0].get('owner')==response['owner'],'RESOURCE_ACTOR_DATA_OWNER_CHANGED')
        return response
    def command_check(self,authority,request):
        identifier=self.action['requestId'];nonce=str(uuid.uuid4())
        # Matches the actual normal Session command join, without transmitting
        # command text or environment/credential values to an audit log.
        raw=json.dumps([request['sessionId'],request['cwd'],request['command']],
                       ensure_ascii=False,separators=(',',':')).encode()
        digest=hashlib.sha256(raw).hexdigest()
        response=self.exchange({'kind':'resource-command-check','requestId':identifier,'nonce':nonce,
            'sessionId':request['sessionId'],'cwd':request['cwd'],'commandDigest':digest})
        exact(response,('kind','requestId','nonce','commandDigest'))
        R.need(response=={'kind':'resource-command-current','requestId':identifier,'nonce':nonce,
                         'commandDigest':digest},'RESOURCE_ACTOR_NORMAL_COMMAND_CHANGED')
        authority.assert_live()
    def check_readiness(self,selected,stage):
        authority=selected['authority'];authority.assert_current()
        record=_plan_record(self,selected,stage);claim=self.owner._current(selected['key'])
        identifier=self.action['requestId'];nonce=str(uuid.uuid4());approval=selected['approval']
        response=self.exchange({'kind':'resource-readiness-check','requestId':identifier,'nonce':nonce,
            'stage':stage,'sessionId':approval['targetSid'],'operationId':approval['operationId'],
            'profileDigest':approval['profileDigest']})
        exact(response,('kind','requestId','nonce','stage','proof'))
        R.need(response['kind']=='resource-readiness-current' and response['requestId']==identifier and
               response['nonce']==nonce and response['stage']==stage,'RESOURCE_ACTOR_READINESS_CHANGED')
        proof=response['proof'];exact(proof,('sessionId','mode','pid','panePid','muxName','readyMarker',
            'normalReadyObservedAt','recipeDigest','recordDigest'))
        recipe=copy.deepcopy(claim['receipt']['afterEmployee'].get('runtimeRecipe'))
        R.need(type(recipe) is dict,'RESOURCE_ACTOR_NORMAL_RECIPE_REQUIRED');recipe.pop('runtimeThreads',None)
        R.need(proof['sessionId']==approval['targetSid'] and proof['mode']==recipe.get('mode') and
               type(proof['pid']) is int and proof['pid']>1 and type(proof['muxName']) is str and
               type(proof['panePid']) is int and proof['panePid']>1 and
               0<len(proof['muxName'])<=256 and type(proof['readyMarker']) is str and
               0<len(proof['readyMarker'])<=64 and type(proof['normalReadyObservedAt']) is int and
               claim['channel_start_at']<=proof['normalReadyObservedAt']<=int(time.time()*1000) and
               proof['recipeDigest']==J.fingerprint(recipe) and proof['recordDigest']==J.fingerprint(record),
               'RESOURCE_ACTOR_READINESS_CHANGED')
        authority.assert_live();return proof,record
    def _selected(self,reference):
        J.canonical_uuid(reference)
        with self.lock:
            selected=self.claims.get(reference)
            R.need(selected is not None,'RESOURCE_ACTOR_COLD_OR_UNKNOWN_CLAIM')
        authority=selected['authority'];authority.assert_current()
        return selected
    def dispatch(self,request):
        return _wire_result(request['verb'],self._dispatch(request))
    def _dispatch(self,request):
        verb=request['verb']
        if verb=='completion':
            exact(request,('kind','requestId','verb','employeeId','operationId'))
            for name in ('employeeId','operationId'):J.canonical_uuid(request[name])
            authority=_OwnerOperation(_MINT,self,request['employeeId'],None)
            from .worker_resource_reconciliation import inspect_completion
            return inspect_completion(self.broker.resource_reservations,authority,request['operationId'])
        if verb=='draft':
            exact(request,('kind','requestId','verb','employeeId','idempotencyKey','memoryMiB'))
            J.canonical_uuid(request['employeeId']);J.canonical_uuid(request['idempotencyKey'])
            R.need(type(request['memoryMiB']) is int and 512<=request['memoryMiB']<=1048576,
                   'RESOURCE_PREPARATION_RAM_REQUEST')
            authority=_OwnerOperation(_MINT,self,request['employeeId'],None);authority.assert_current()
            result=self.owner.draft(request['employeeId'],request['idempotencyKey'],
                                    memory_mib=request['memoryMiB']);authority.assert_live()
            return result
        if verb=='claim':
            exact(request,('kind','requestId','verb','approval'))
            approval=request['approval']
            exact(approval,('employeeId','draftId','operationId','reservationId','targetSid','profileVersion',
                            'profileDigest','previewDigest'))
            for field in ('employeeId','draftId','operationId','reservationId','targetSid'):J.canonical_uuid(approval[field])
            for field in ('profileDigest','previewDigest'):J.digest(approval[field])
            J.version(int(approval['profileVersion']),True)
            authority=_OwnerOperation(_MINT,self,approval['employeeId'],approval);authority.assert_current()
            draft=R._file(self.owner.gate.root/'operations'/('draft-'+approval['draftId']+'.json'),self.broker.config['uid'])
            R.need(draft['profile']['binding']['employee_id']==approval['employeeId'] and
                draft['operationId']==approval['operationId'] and draft['reservationId']==approval['reservationId'] and
                draft['targetSid']==approval['targetSid'] and str(draft['profile']['version'])==approval['profileVersion'] and
                J.fingerprint(draft['profile'])==approval['profileDigest'] and
                J.fingerprint(draft)==approval['previewDigest'],'RESOURCE_ACTOR_APPROVAL_CHANGED')
            result=self.owner.reserve(approval['draftId'],approval['previewDigest']);key=result['claimKey']
            reference=str(uuid.uuid4());claim=self.owner._current(key);claim['owner_authority']=authority
            selected={'key':key,'authority':authority,'reference':reference,'approval':copy.deepcopy(approval)}
            self.claims[reference]=selected
            intent=self.owner.begin_prepare(key);authority.assert_live()
            return {'reference':reference,'sessionId':result['sessionId'],'state':intent['state'],
                    'publicationIntentDigest':intent['publicationIntentDigest']}
        exact(request,('kind','requestId','verb','reference'))
        selected=self._selected(request['reference']);key=selected['key'];authority=selected['authority']
        if verb=='publication':return self.owner.confirm_publication(key)
        if verb=='prepare':
            self.owner.stage_configuration(key);return self.owner._commit_configuration(key)
        if verb=='source-stop':
            record=_plan_record(self,selected,'stop')
            self.owner._current(key)['plan_context']=(self,selected,'stop',record)
            permit=self.owner._begin_start(key)
            return self.owner._stop_source_once(key,permit)
        if verb=='start':
            claim=self.owner._current(key)
            record=_plan_record(self,selected,'start');claim['plan_context']=(self,selected,'start',record)
            R.need(claim.get('source_stop_completed') is True and not claim.get('channel_start_attempted'),
                   'RESOURCE_ACTOR_SOURCE_RELEASE_REQUIRED')
            claim['channel_start_attempted']=True;claim['canonical_settled_event']=threading.Event()
            claim['channel_start_at']=int(time.time()*1000)
            with self.service._lock:
                R.need(selected['reference'] not in self.service._launches,'RESOURCE_ACTOR_LAUNCH_ALREADY_ATTEMPTED')
                self.service._launches[selected['reference']]=(self,key,authority)
            self.send({'kind':'resource-launch-ready','requestId':request['requestId'],'reference':selected['reference']})
            R.need(claim['canonical_settled_event'].wait(max(0,min(180,self.deadline-time.monotonic()))) and
                   claim.get('canonical_released') is True and not claim.get('canonical_error'),
                   'RESOURCE_ACTOR_CANONICAL_START_UNCERTAIN')
            from .worker_resource_native import acknowledge_started
            return acknowledge_started(self.owner,key)
        if verb=='verify':
            from .worker_resource_native import begin_verification,acknowledge_verified
            record=_plan_record(self,selected,'verify');claim=self.owner._current(key)
            claim['plan_context']=(self,selected,'verify',record)
            begin_verification(self.owner,key)
            proof,record=self.check_readiness(selected,'verify')
            readiness=_ReadinessProof(_MINT,self,selected,'verify',proof,record)
            claim['readiness_proof']=readiness
            return acknowledge_verified(self.owner,key,readiness)
        if verb=='finalize':
            from .worker_resource_finalization import complete
            record=_plan_record(self,selected,'finalize');claim=self.owner._current(key)
            claim['plan_context']=(self,selected,'finalize',record)
            proof,record=self.check_readiness(selected,'finalize')
            readiness=_ReadinessProof(_MINT,self,selected,'finalize',proof,record)
            claim['final_readiness']=readiness
            return complete(self.owner,key,readiness)
        raise J.OperationRefusal('RESOURCE_ACTOR_CLOSED_OPERATION')
    def _run(self,request):
        try:
            result=self.dispatch(request)
            self.finish_reply({'kind':'resource-result','requestId':request['requestId'],'value':result})
        except BaseException:
            try:self.send({'kind':'resource-refused','requestId':request['requestId'],
                           'reason':'RESOURCE_OPERATION_UNCONFIRMED_KEEP_CLAIM'})
            finally:self.close()
        finally:
            with self.lock:
                if self.action is not None and self.action['requestId']==request['requestId']:self.action=None
            if self.closed.is_set():self.owner.close()
    def serve(self):
        while not self.closed.is_set():
            R.need(time.monotonic()<self.deadline,'RESOURCE_ACTOR_CHANNEL_EXPIRED')
            if not select.select([self.wire.channel.node],[],[],.1)[0]:continue
            self.frames+=1;R.need(self.frames<=MAX_FRAMES,'RESOURCE_ACTOR_FRAME_BOUND')
            self.wire.deadline=min(self.deadline,time.monotonic()+5)
            value=self.wire.read()
            if type(value) is dict and value.get('kind') in ('resource-owner-current','resource-command-current','resource-readiness-current'):
                nonce=value.get('nonce');J.canonical_uuid(nonce)
                with self.lock:
                    waiter=self.waiters.get(nonce)
                    R.need(waiter is not None and waiter['reply'] is None,'RESOURCE_ACTOR_UNEXPECTED_PROOF')
                    waiter['reply']=value;waiter['event'].set()
            else:
                R.need(type(value) is dict and value.get('kind')=='resource-operation' and
                    value.get('verb') in ('draft','claim','publication','prepare','source-stop','start','verify','finalize','completion'),
                    'RESOURCE_ACTOR_CLOSED_OPERATION')
                J.canonical_uuid(value.get('requestId'))
                with self.lock:
                    R.need(self.action is None,'RESOURCE_ACTOR_OPERATION_ALREADY_ACTIVE')
                    self.action={'requestId':value['requestId'],'checks':0}
                    self.action_thread=threading.Thread(target=self._run,args=(copy.deepcopy(value),),daemon=True)
                    self.action_thread.start()
