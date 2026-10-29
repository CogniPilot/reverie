"""Private retained-claim preparation primitives, not an exposed resource actor.

No Broker/HTTP/UDS entry registers these primitives. A separately qualified
installer-owned server/owner bootstrap must precede exposing any effect entry.
UUIDs, request JSON, host UID and the process-local key do not supply approval.
This module never publishes company/session metadata, stops or launches a CLI,
credits capacity, releases the durable claim or rewrites an approved profile.
"""
import copy
from dataclasses import dataclass
import os
import secrets
import stat
import uuid
from pathlib import Path

from . import laptop_resource_operations as J
from .employee_resource_profiles import ProfileStore
from .worker_resources import effective_config, RESOURCE_FIELDS, validate_resources
from .goal_private import private_entry
from .worker_storage import read_metadata, storage_paths, storage_start_allowed
from .worker_capacity_policy import pool_headroom_fits
from .worker_resource_reservations import (
    ReservationGate, _RetainedClaim, need, _write_exclusive, _file, compatibility_candidate,
)


@dataclass(frozen=True)
class _PhaseBoundary:
    owner: object
    claim: object
    expected_employee: dict
    expected_config: dict
    published: bool = True


def _document(gate):
    """Existing accepted journal reader, no second schema or effect lease."""
    store = gate._store(); lock = None
    try:
        store._root()
        lock = os.open('operations.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                       dir_fd=store.fd)
        store._lock_identity(lock)
        import fcntl
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        document, signature = store._read()
        store._root(); store._lock_identity(lock)
        return document, signature
    finally:
        try:
            if lock is not None:os.close(lock)
        finally:store.close()


def _owner_live(claim):
    authority=claim.get('owner_authority')
    if authority is not None:
        from .worker_resource_actor import _OwnerOperation
        need(type(authority) is _OwnerOperation,'RESOURCE_ACTOR_OWNER_CONTEXT_REQUIRED')
        authority.assert_live()
    if claim.get('plan_context') is not None:
        from .worker_resource_actor import _plan_current
        _plan_current(claim)


def _target_recipe(before):
    """Normal same-account runtime-refresh selectors, not a context transfer.

    The normal TS transaction sends the owner's explicit handoff only after
    initial readiness. No historical provider resume ID supplies that proof.
    """
    recipe=copy.deepcopy(before)
    need(type(recipe) is dict and recipe.get('mode') in ('claude','codex'),
         'RESOURCE_PREPARATION_NORMAL_RECIPE_REQUIRED')
    recipe['runtimeThreads']={}
    if recipe['mode']=='codex':
        config=recipe.get('configs',{}).get('codexConfig')
        if config is not None:
            need(type(config) is dict,'RESOURCE_PREPARATION_NORMAL_RECIPE_REQUIRED')
            config.pop('resumeSessionId',None)
    return recipe


def _policy_current(gate,claim):
    """Final anchored metadata read only; no native producer may follow it."""
    from .worker import validate_config
    path=claim['policy_path']
    need(Path(gate.broker.config_file)==path,'RESOURCE_PREPARATION_CONFIG_CHANGED')
    signature,_raw=private_entry(str(path),limit=J.MAX_BYTES)
    parent=path.parent.lstat()
    need([parent.st_dev,parent.st_ino]==claim['policy_directory'] and
         stat.S_ISDIR(parent.st_mode) and stat.S_IMODE(parent.st_mode)==0o700 and
         parent.st_uid==gate.broker.config['uid'] and signature==claim['policy_signature'],
         'RESOURCE_PREPARATION_CONFIG_CHANGED')
    actual=read_metadata(path,gate.broker.config['uid'],limit=J.MAX_BYTES)
    expected=claim['candidate'] if claim['policy_published'] else claim['before']
    need(validate_config(actual)==expected,'RESOURCE_PREPARATION_CONFIG_CHANGED')
    # Include all descriptor finalizers/typed validation before the final stamp.
    current=path.lstat();parent=path.parent.lstat()
    need([str(current.st_dev),str(current.st_ino),str(current.st_size),str(current.st_mtime_ns),
          str(current.st_ctime_ns)]==signature and stat.S_IMODE(current.st_mode)==0o600 and
         [parent.st_dev,parent.st_ino]==claim['policy_directory'],'RESOURCE_PREPARATION_CONFIG_CHANGED')
    _owner_live(claim)


@dataclass(frozen=True)
class _PolicyAckFence:
    owner: object
    claim: object


def _ack_policy_current(gate,fence):
    """Fixed scope fence, safe while the existing journal flock is held."""
    need(type(fence) is _PolicyAckFence and fence.owner.gate is gate,
         'RESOURCE_PREPARATION_ACK_CONTEXT_REQUIRED')
    claim=fence.owner._current(fence.claim)
    need(claim['lease'].gate is gate and claim['config_attempted'] and claim['policy_published'] and
         gate.broker.config==claim['candidate'],'RESOURCE_PREPARATION_ACK_CONTEXT_REQUIRED')
    gate.native.custody(claim['policy_path'].parent,claim['policy_path'])
    _policy_current(gate,claim)


def _finish_phase(gate, boundary):
    """Finite terminal observation for the one intended published-SID phase."""
    need(type(boundary) is _PhaseBoundary and boundary.owner.gate is gate,
         'RESOURCE_PREPARATION_BOUNDARY_REQUIRED')
    owner = boundary.owner; claim = owner._current(boundary.claim)
    need(claim['lease'].gate is gate, 'RESOURCE_PREPARATION_BOUNDARY_REQUIRED')
    document, signature = _document(gate)
    op = document['operations'].get(claim['lease'].view['operation']['id'])
    need(op == claim['lease'].view['operation'] and op['state'] in ('PREPARING','PREPARED'),
         'RESOURCE_PREPARATION_CLAIM_CHANGED')
    phase_path = gate.root/'operations'/('publication-'+op['id']+'.json')
    phase_before = phase_path.lstat()
    stamp = lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
    need(stat.S_ISREG(phase_before.st_mode) and stat.S_IMODE(phase_before.st_mode)==0o600 and
         phase_before.st_uid==gate.broker.config['uid'] and phase_before.st_nlink==1 and
         stamp(phase_before)==claim['phase_signature'], 'RESOURCE_PREPARATION_PHASE_CHANGED')
    need(read_metadata(phase_path,gate.broker.config['uid'],limit=J.MAX_BYTES) == claim['receipt'],
         'RESOURCE_PREPARATION_PHASE_CHANGED')
    context = claim['lease'].context; observed = context['observation']; profile = context['profile']
    rows = gate._guard()
    need(rows == context['native'], 'RESOURCE_PREPARATION_NATIVE_CHANGED')
    total, budget, site, commitments = gate.native.capacity(rows, gate.option)
    epoch = J.fingerprint({'pool': observed['pool_id'], 'budget': budget, 'site': site,
        'reserve': gate.option['hostReserveMiB'], 'commitments': sorted(commitments, key=lambda r:r['containerId'])})
    need(epoch == observed['pool_revision_digest'] and str(total) == observed['committed_bytes'] and
         str(budget) == observed['budget_bytes'], 'RESOURCE_PREPARATION_CAPACITY_CHANGED')
    source = [row for row in rows if row['Id'] == claim['source_id']]
    need(len(source) == 1, 'RESOURCE_PREPARATION_SOURCE_CHANGED')
    _, native = gate.native.limits(source[0])
    storage = gate.native.storage(source[0], claim['source_paths'])
    need(J.fingerprint({'employee': context['employee'], 'native': native, 'storage': storage,
         'profile': profile}) == observed['source_binding_digest'], 'RESOURCE_PREPARATION_SOURCE_CHANGED')
    if claim['config_attempted']:
        gate.native.custody(claim['policy_path'].parent,claim['policy_path'])
    # No further kernel/engine producers after the final custody bracket.
    need(gate._guard() == rows, 'RESOURCE_PREPARATION_NATIVE_CHANGED')
    if claim['config_attempted']:_policy_current(gate,claim)
    current = (gate.root / 'operations/operations.json').lstat()
    need((current.st_dev,current.st_ino,current.st_size,current.st_mtime_ns,current.st_ctime_ns) == signature,
         'RESOURCE_PREPARATION_CLAIM_CHANGED')
    phase_after = phase_path.lstat()
    need(stamp(phase_before) == stamp(phase_after), 'RESOURCE_PREPARATION_PHASE_CHANGED')
    need(type(boundary.published) is bool and boundary.expected_employee == claim['receipt'][
         'afterEmployee' if boundary.published else 'beforeEmployee'], 'RESOURCE_PREPARATION_PUBLICATION_CHANGED')
    need(boundary.expected_config == claim['before'] or claim['config_attempted'] and
         boundary.expected_config == claim.get('candidate'), 'RESOURCE_PREPARATION_CONFIG_CHANGED')
    need(gate.broker.config == boundary.expected_config, 'RESOURCE_PREPARATION_CONFIG_CHANGED')
    need(gate._profile(observed['employee_id']) == profile, 'RESOURCE_PREPARATION_PROFILE_CHANGED')
    company = read_metadata(gate.broker.config['companyFile'], gate.broker.config['uid'])
    need([row for row in company['employees'] if row.get('id') == observed['employee_id']] ==
         [boundary.expected_employee], 'RESOURCE_PREPARATION_PUBLICATION_CHANGED')
    target = storage_paths(gate.broker.config, profile['binding']['target_sid'])
    if boundary.published:
        need(target.kind == 'employee' and target.identity == observed['employee_id'] and
             target.home == claim['source_paths'].home and target.nix == claim['source_paths'].nix and
             target.scratch == claim['source_paths'].scratch and storage_start_allowed(gate.broker.config,target),
             'RESOURCE_PREPARATION_STORAGE_CHANGED')
    else:
        source_paths=storage_paths(gate.broker.config,profile['binding']['current_sid'])
        need(source_paths==claim['source_paths'] and storage_start_allowed(gate.broker.config,source_paths) and
             target.kind=='session' and target.identity==profile['binding']['target_sid'] and
             not os.path.lexists(Path(gate.broker.config['stateRoot'])/profile['binding']['target_sid']),
             'RESOURCE_PREPARATION_STORAGE_CHANGED')
    _owner_live(claim)


@dataclass(frozen=True)
class _ReloadBoundary:
    owner: object
    claim: object
    candidate: dict


def _allow_reload(gate,boundary,updated,document):
    """Only this fixed in-process PREPARING transaction may change projections."""
    need(type(boundary) is _ReloadBoundary and boundary.owner.gate is gate,
         'RESOURCE_PREPARATION_RELOAD_CONTEXT_REQUIRED')
    claim = boundary.owner._current(boundary.claim); lease = claim['lease']
    op = document['operations'].get(lease.view['operation']['id'])
    need(lease.gate is gate and op == lease.view['operation'] and op['state'] == 'PREPARING' and
         updated == boundary.candidate == claim.get('candidate') and
         gate.broker.config == claim['before'] and claim['config_attempted'],
         'RESOURCE_PREPARATION_RELOAD_CHANGED')
    _finish_phase(gate,_PhaseBoundary(boundary.owner,boundary.claim,
        copy.deepcopy(claim['receipt']['afterEmployee']),copy.deepcopy(claim['before'])))


def _exclusive_raw(path,raw):
    need(type(raw) is bytes and len(raw) <= J.MAX_BYTES, 'RESOURCE_PREPARATION_CONFIG_BOUND')
    fd = os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        os.fchmod(fd,0o600)
        while raw:
            count=os.write(fd,raw);need(count>0,'RESOURCE_PREPARATION_SHORT_WRITE');raw=raw[count:]
        os.fsync(fd)
    finally:os.close(fd)
    directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:os.fsync(directory)
    finally:os.close(directory)


class ResourcePreparationOwner:
    """Retain real in-process handles; cold lookup never revives ownership.

    These methods are host integration primitives, not PlanMoveResourceRuntime
    registration or an authenticated owner endpoint. No start/verify substitute
    is supplied. In particular, a PREPARING receipt is never a native ACK.
    """
    def __init__(self, broker):
        gate = broker.resource_reservations
        need(type(gate) is ReservationGate and gate.broker is broker, 'RESOURCE_PREPARATION_GATE_REQUIRED')
        self.broker, self.gate = broker, gate
        self._claims = {}

    def _current(self, key):
        claim = self._claims.get(key)
        need(claim is not None and type(claim['lease']) is _RetainedClaim and
             not claim['lease'].closed, 'RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED')
        authority=claim.get('owner_authority')
        if authority is not None:
            from .worker_resource_actor import _OwnerOperation
            need(type(authority) is _OwnerOperation and authority.connection.owner is self,
                 'RESOURCE_ACTOR_OWNER_CONTEXT_REQUIRED')
            authority.assert_current()
        return claim

    def _select_profile(self,employee_id,memory_mib):
        """Pre-approval RAM intent only, under the existing admission lock.

        All identity and non-RAM fields come from current canonical data. This
        may invalidate an older preview; it never changes an executing claim,
        a laptop policy, company binding or native allocation.
        """
        need(type(memory_mib) is int and 512<=memory_mib<=1048576,
             'RESOURCE_PREPARATION_RAM_REQUEST')
        history=self.gate._document()
        need(not any(op['request']['employee_id']==employee_id
                     for op in self.gate.active_operations(history)),
             'RESOURCE_PREPARATION_EMPLOYEE_CLAIM_RETAINED')
        rows=self.gate._guard()
        company=read_metadata(self.broker.config['companyFile'],self.broker.config['uid'])
        employees=[row for row in company['employees'] if row.get('id')==employee_id]
        need(len(employees)==1,'RESOURCE_PREPARATION_CURRENT_EMPLOYEE_REQUIRED')
        employee=employees[0];sid=employee.get('sessionId');J.canonical_uuid(sid)
        generation=employee.get('sessionGeneration');J.version(generation,True)
        need(employee.get('desiredRunning') is True and not employee.get('onVacation') and
             not employee.get('bindingMigration') and
             J.fingerprint({'company_id':self.gate.scope['company_id'],'owner':employee.get('owner')})==
             self.gate.scope['owner_scope_digest'],'RESOURCE_PREPARATION_CURRENT_EMPLOYEE_REQUIRED')
        paths=storage_paths(self.broker.config,sid)
        need(paths.kind=='employee' and paths.identity==employee_id and
             storage_start_allowed(self.broker.config,paths),'RESOURCE_PREPARATION_CURRENT_EMPLOYEE_REQUIRED')
        current=effective_config(self.broker.config,sid)
        resources={name:copy.deepcopy(current[name]) for name in RESOURCE_FIELDS}
        resources['memoryMiB']=memory_mib;validate_resources(resources)
        need(resources['budgetMode']=='admission','RESOURCE_PREPARATION_ADMISSION_REQUIRED')
        target=str(uuid.uuid4())
        occupied={identifier for op in history['operations'].values() for identifier in
                  (op['id'],op['reservation_id'],op['reserved_sid'],op['observation']['current_sid'])}
        need(target!=sid and target not in occupied and
             storage_paths(self.broker.config,target).kind=='session' and
             not os.path.lexists(Path(self.broker.config['stateRoot'])/target) and
             not any((row.get('Config',{}).get('Labels') or {}).get('reverie.session')==target for row in rows),
             'RESOURCE_PREPARATION_DRAFT_IDS')
        profiles=ProfileStore(self.gate.root/'profiles')
        try:
            snapshot=profiles.snapshot();old=snapshot['profiles'].get(employee_id)
            need(not any(target in (value['binding']['current_sid'],value['binding']['target_sid'])
                         for value in snapshot['profiles'].values()),'RESOURCE_PREPARATION_DRAFT_IDS')
            need(self.gate._guard()==rows and
                 read_metadata(self.broker.config['companyFile'],self.broker.config['uid'])==company and
                 storage_paths(self.broker.config,sid)==paths,
                 'RESOURCE_PREPARATION_SOURCE_CHANGED')
            profiles.put(employee_id,resources,{'employee_id':employee_id,'current_sid':sid,'target_sid':target,
                'current_generation':generation,'target_generation':generation+1},
                expected_revision=snapshot['revision'],expected_profile_version=old['version'] if old else 0,
                expected_binding=old['binding'] if old else None)
        finally:profiles.close()

    def draft(self,employee_id,idempotency_key,*,memory_mib=None):
        """Private preview preselection; no claim, handle or capacity hold."""
        J.canonical_uuid(employee_id);J.canonical_uuid(idempotency_key)
        with self.gate.admission():
            if memory_mib is not None:self._select_profile(employee_id,memory_mib)
            store=self.gate._store()
            try:
                profile=self.gate._profile(employee_id)
                need(profile is not None,'RESOURCE_PREPARATION_PROFILE_MISSING')
                self.gate._local.approved_profile=copy.deepcopy(profile)
                def preview(document,_context,_lock):
                    observed=self.gate._observe_claim(self.gate.scope,self.gate.option['poolId'],employee_id)
                    held=self.gate._retained_delta(document)
                    need(pool_headroom_fits(budget_bytes=int(observed['budget_bytes']),
                         committed_bytes=int(observed['committed_bytes']),retained_bytes=held,
                         candidate_bytes=max(0,profile['resources']['memoryMiB']*J.MIB-
                                             int(observed['current_memory_bytes']))),
                         'RESOURCE_PREPARATION_DRAFT_CAPACITY')
                    operation_id,reservation_id,draft_id=(str(uuid.uuid4()) for _ in range(3))
                    target=profile['binding']['target_sid'];J.canonical_uuid(target)
                    need(len({operation_id,reservation_id,target,draft_id,observed['current_sid']})==5,
                         'RESOURCE_PREPARATION_DRAFT_IDS')
                    occupied={identifier for op in document['operations'].values() for identifier in
                              (op['id'],op['reservation_id'],op['reserved_sid'],op['observation']['current_sid'])}
                    need(not {operation_id,reservation_id,target}&occupied,'RESOURCE_PREPARATION_DRAFT_IDS')
                    return {'schema':'reverie-resource-private-draft-v1','draftId':draft_id,
                        'idempotencyKey':idempotency_key,'operationId':operation_id,'reservationId':reservation_id,
                        'targetSid':target,'scope':copy.deepcopy(self.gate.scope),'profile':copy.deepcopy(profile),
                        'observation':observed},copy.deepcopy(document)
                record,document=store._locked(self.gate.scope,preview)
            finally:store.close()
            directory=self.gate.root/'operations'
            count=0
            for total,entry in enumerate(directory.iterdir(),1):
                need(total<=4096,'RESOURCE_PREPARATION_DRAFT_BOUND')
                if entry.name.startswith('draft-') and entry.name.endswith('.json'):count+=1
                need(count<256,'RESOURCE_PREPARATION_DRAFT_BOUND')
            _write_exclusive(directory/('draft-'+record['draftId']+'.json'),record)
            company=read_metadata(self.broker.config['companyFile'],self.broker.config['uid'])
            employee=[row for row in company['employees'] if row.get('id')==employee_id]
            need(len(employee)==1,'RESOURCE_PREPARATION_SOURCE_CHANGED')
            self.gate._local.terminal_claim={'profile':copy.deepcopy(profile),'employee':copy.deepcopy(employee[0]),
                'document':document,'native':copy.deepcopy(self.gate._local.claim_native),
                'observation':record['observation']}
        return {'draftId':record['draftId'],'operationId':record['operationId'],'reservationId':record['reservationId'],
                'targetSid':record['targetSid'],'profileVersion':str(profile['version']),
                'profileDigest':J.fingerprint(profile),'previewDigest':J.fingerprint(record),
                'resources':copy.deepcopy(profile['resources']),
                'sourceMemoryMiB':int(record['observation']['current_memory_bytes'])//J.MIB,
                'capacityHeld':False,'nativeEffects':False}

    def reserve(self,draft_id,expected_preview_digest):
        """Executing-Apply primitive; IDs are consumed unchanged, not approval."""
        J.canonical_uuid(draft_id);J.digest(expected_preview_digest)
        record=_file(self.gate.root/'operations'/('draft-'+draft_id+'.json'),self.broker.config['uid'])
        need(type(record) is dict and set(record)=={'schema','draftId','idempotencyKey','operationId','reservationId',
             'targetSid','scope','profile','observation'} and record['schema']=='reverie-resource-private-draft-v1' and
             record['draftId']==draft_id and record['scope']==self.gate.scope and
             J.fingerprint(record)==expected_preview_digest,'RESOURCE_PREPARATION_DRAFT_CHANGED')
        for field in ('idempotencyKey','operationId','reservationId','targetSid'):J.canonical_uuid(record[field])
        J.observation(record['observation']);profile=record['profile'];observed=record['observation']
        need(record['targetSid']==profile['binding']['target_sid'] and
             self.gate._profile(observed['employee_id'])==profile,'RESOURCE_PREPARATION_DRAFT_CHANGED')
        request={'employee_id':observed['employee_id'],'pool_id':observed['pool_id'],
            'source_binding_digest':observed['source_binding_digest'],'profile_version':str(profile['version']),
            'requested_memory_bytes':str(profile['resources']['memoryMiB']*J.MIB),
            'preview_digest':expected_preview_digest,'observation_digest':J.fingerprint(observed)}
        lease = self.gate._retain_claim(record['idempotencyKey'],request,
            operation_id=record['operationId'],reservation_id=record['reservationId'])
        try:
            before=lease.before_config;paths=lease.source_paths
            need(self.broker.config == before, 'RESOURCE_PREPARATION_CONFIG_CHANGED')
            binding = lease.context['profile']['binding']
            source = [row for row in lease.context['native'] if
                (row.get('Config',{}).get('Labels') or {}).get('reverie.worker') == before['deployment'] and
                (row['Config']['Labels'] or {}).get('reverie.session') == binding['current_sid']]
            need(len(source) == 1, 'RESOURCE_PREPARATION_SOURCE_CHANGED')
            key = object()
            self._claims[key] = {'lease':lease, 'before':before, 'source_paths':paths,
                                 'source_id':source[0]['Id'], 'native_baseline':copy.deepcopy(lease.native_baseline),
                                 'preparing_attempted':False, 'published':False,
                                 'config_attempted':False}
            return {'sessionId':binding['target_sid'], 'claimKey':key,
                    'operation':copy.deepcopy(lease.view)}
        except BaseException as error:
            try:lease.close()
            except BaseException:error.add_note('RESOURCE_PREPARATION_CLOSE_UNCONFIRMED')
            raise J.OperationCommitUncertain('RESOURCE_PREPARATION_RESERVE_UNCERTAIN_KEEP_CLAIM') from error

    def begin_prepare(self, key):
        claim = self._current(key); lease = claim['lease']; profile = lease.context['profile']
        need(not claim['preparing_attempted'], 'RESOURCE_PREPARATION_ALREADY_ATTEMPTED')
        claim['preparing_attempted'] = True
        try:
            with self.gate.admission():
                self.gate._local.approved_profile = copy.deepcopy(profile)
                need(self.gate._observe_claim(self.gate.scope,lease.view['operation']['request']['pool_id'],profile['binding']['employee_id']) ==
                     lease.context['observation'], 'RESOURCE_PREPARATION_SOURCE_CHANGED')
                lease.view = lease.store.begin_effect(self.gate.scope,lease.handle,'prepare',
                                                      expected_version=lease.view['operation']['version'])
                before = copy.deepcopy(lease.context['employee']); after = copy.deepcopy(before)
                after.update(sessionId=profile['binding']['target_sid'],
                             sessionGeneration=profile['binding']['target_generation'])
                if 'runtimeRecipe' in after:after['runtimeRecipe']=_target_recipe(after['runtimeRecipe'])
                receipt = {'schema':'reverie-resource-publication-intent-v2',
                    'operationId':lease.view['operation']['id'], 'reservationId':lease.view['operation']['reservation_id'],
                    'profileVersion':profile['version'], 'profileDigest':J.fingerprint(profile),
                    'beforeEmployee':before, 'afterEmployee':after,
                    'nativeBaseline':copy.deepcopy(claim['native_baseline']),
                    'beforeConfigDigest':J.fingerprint(claim['before']), 'state':'PREPARING'}
                need(len(J.encode(receipt)) <= J.MAX_BYTES, 'RESOURCE_PREPARATION_RECEIPT_BOUND')
                path = self.gate.root/'operations'/('publication-'+receipt['operationId']+'.json')
                _write_exclusive(path,receipt)
                claim['receipt'] = receipt
                phase=path.lstat()
                claim['phase_signature']=(phase.st_dev,phase.st_ino,phase.st_size,phase.st_mtime_ns,phase.st_ctime_ns)
                def final(document,_context,_lock):
                    need(document['operations'].get(receipt['operationId']) == lease.view['operation'],
                         'RESOURCE_PREPARATION_CLAIM_CHANGED')
                    need(self.gate._observe_claim(self.gate.scope,lease.view['operation']['request']['pool_id'],
                         profile['binding']['employee_id']) == lease.context['observation'],
                         'RESOURCE_PREPARATION_SOURCE_CHANGED')
                    return copy.deepcopy(document)
                document = lease.store._locked(self.gate.scope,final)
                self.gate._local.preparation_boundary = _PhaseBoundary(
                    self,key,copy.deepcopy(before),copy.deepcopy(claim['before']),published=False)
            return {'state':'PREPARING','publicationIntentDigest':J.fingerprint(receipt),
                    'sessionId':profile['binding']['target_sid']}
        except BaseException as error:
            try:lease.close()
            except BaseException:error.add_note('RESOURCE_PREPARATION_CLOSE_UNCONFIRMED')
            raise J.OperationCommitUncertain('RESOURCE_PREPARATION_INTENT_UNCERTAIN_KEEP_CLAIM') from error
        finally:
            self.gate._local.approved_profile = None

    def confirm_publication(self, key):
        """Observe the exact intended normal server rebind; never perform it."""
        claim = self._current(key)
        need('receipt' in claim and claim['preparing_attempted'], 'RESOURCE_PREPARATION_INTENT_REQUIRED')
        try:
            with self.gate.admission():
                self.gate._local.preparation_boundary = _PhaseBoundary(
                    self,key,copy.deepcopy(claim['receipt']['afterEmployee']),copy.deepcopy(claim['before']))
            claim['published'] = True
            return {'state':'PUBLISHED_METADATA_ONLY','verified':False,'retryAllowed':False}
        except BaseException as error:
            try:claim['lease'].close()
            except BaseException:error.add_note('RESOURCE_PREPARATION_CLOSE_UNCONFIRMED')
            raise J.OperationCommitUncertain('RESOURCE_PREPARATION_PUBLICATION_UNCERTAIN_KEEP_CLAIM') from error

    def stage_configuration(self, key):
        """Use the real canonical profile and OLD6 compatibility helper, no write."""
        claim = self._current(key); need(claim['published'], 'RESOURCE_PREPARATION_PUBLICATION_REQUIRED')
        with self.gate.admission():
            lease = claim['lease']; profile = lease.context['profile']; binding = profile['binding']
            self.gate._local.preparation_boundary = _PhaseBoundary(
                self,key,copy.deepcopy(claim['receipt']['afterEmployee']),copy.deepcopy(claim['before']))
            profiles = ProfileStore(self.gate.root/'profiles')
            try:
                snapshot = profiles.snapshot(); need(snapshot['profiles'].get(binding['employee_id']) == profile,
                                                     'RESOURCE_PREPARATION_PROFILE_CHANGED')
                staged = profiles.stage_config(claim['before'],binding['employee_id'],binding,
                    expected_revision=snapshot['revision'],expected_profile_version=profile['version'],
                    sid_owners={binding['current_sid']:binding['employee_id'],binding['target_sid']:binding['employee_id']})
            finally:profiles.close()
            candidate = compatibility_candidate(claim['before'],staged['config'],binding['current_sid'],binding['target_sid'])
            return {'config':candidate,'profileVersion':profile['version'],
                    'profileDigest':J.fingerprint(profile),'state':'STAGED_ONLY_NOT_RELOADED'}

    def _commit_configuration(self,key):
        """Unregistered internal native preparation primitive, never owner auth.

        The future fixed bootstrap MUST authenticate current owner/session and
        native service custody before routing to this method. No current Broker
        entry, website dependency or HTTP/UDS route calls it.
        """
        from .worker import load_config, validate_config
        from .worker_resource_reservations import _directory
        claim=self._current(key);need(claim['published'],'RESOURCE_PREPARATION_PUBLICATION_REQUIRED')
        need(not claim['config_attempted'],'RESOURCE_PREPARATION_CONFIG_ALREADY_ATTEMPTED')
        candidate=self.stage_configuration(key)['config'];validate_config(candidate)
        need(self.broker.config_file is not None,'RESOURCE_PREPARATION_CONFIG_FILE_REQUIRED')
        config_path=Path(self.broker.config_file)
        # Complete configured/current/stopped/RO/nested exposure census remains
        # mandatory for the host policy, not just for the reservation root.
        directory=None;temporary=None
        try:
            with self.gate.admission():
                boundary=_PhaseBoundary(self,key,copy.deepcopy(claim['receipt']['afterEmployee']),
                                        copy.deepcopy(claim['before']))
                self.gate._local.preparation_boundary=boundary
                _finish_phase(self.gate,boundary)
                self.gate.native.custody(config_path.parent,config_path)
                directory,identity=_directory(config_path.parent,self.broker.config['uid'])
                original=os.open(config_path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=directory)
                try:
                    signature=J.private_file(original);before=os.read(original,J.MAX_BYTES+1)
                    need(len(before)==signature[2] and len(before)<=J.MAX_BYTES and
                         J.private_file(original)==signature,'RESOURCE_PREPARATION_CONFIG_CHANGED')
                finally:os.close(original)
                need(load_config(config_path)==claim['before'],'RESOURCE_PREPARATION_CONFIG_CHANGED')
                claim['policy_path']=config_path;claim['policy_directory']=identity
                claim['policy_signature']=[str(value) for value in signature]
                claim['policy_published']=False
                claim['config_attempted']=True
                claim['candidate']=copy.deepcopy(candidate)
                opid=claim['lease'].view['operation']['id']
                _write_exclusive(self.gate.root/'operations'/('config-attempt-'+opid+'.json'),
                    {'schema':'reverie-resource-config-attempt-v1','operationId':opid,
                     'beforeDigest':J.fingerprint(claim['before']),'afterDigest':J.fingerprint(candidate)})
                _exclusive_raw(self.gate.root/'operations'/('config-before-'+opid+'.json'),before)
                temporary='.resource-preparing-'+secrets.token_hex(16)
                raw=J.encode(candidate)
                out=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=directory)
                try:
                    os.fchmod(out,0o600)
                    view=memoryview(raw)
                    while view:
                        count=os.write(out,view);need(count>0,'RESOURCE_PREPARATION_SHORT_WRITE');view=view[count:]
                    os.fsync(out)
                finally:os.close(out)
                self.gate.native.custody(config_path.parent,config_path)
                verify,again=_directory(config_path.parent,self.broker.config['uid'])
                try:need(again==identity,'RESOURCE_PREPARATION_CONFIG_DIRECTORY_CHANGED')
                finally:os.close(verify)
                # Complete the last engine/custody work before terminal phase
                # facts and the adjacent exact policy-file CAS/rename.
                _finish_phase(self.gate,boundary)
                current=os.stat(config_path.name,dir_fd=directory,follow_symlinks=False)
                need((current.st_dev,current.st_ino,current.st_size,current.st_mtime_ns,current.st_ctime_ns)==signature,
                     'RESOURCE_PREPARATION_CONFIG_CHANGED')
                os.rename(temporary,config_path.name,src_dir_fd=directory,dst_dir_fd=directory)
                os.fsync(directory)
                # Close every transaction descriptor before final observation.
                os.close(directory);directory=None
                need(load_config(config_path)==candidate,'RESOURCE_PREPARATION_CONFIG_CHANGED')
                claim['policy_signature'],_raw=private_entry(str(config_path),limit=J.MAX_BYTES)
                claim['policy_published']=True
                self.gate._local.preparation_reload=_ReloadBoundary(self,key,copy.deepcopy(candidate))
                try:self.broker._reload_resources()
                finally:self.gate._local.preparation_reload=None
                need(self.broker.config==candidate and load_config(config_path)==candidate,
                     'RESOURCE_PREPARATION_RELOAD_UNCONFIRMED')
                boundary=_PhaseBoundary(self,key,copy.deepcopy(claim['receipt']['afterEmployee']),copy.deepcopy(candidate))
                self.gate._local.preparation_boundary=boundary
                _finish_phase(self.gate,boundary)
                receipt={'schema':'reverie-resource-native-preparation-v1','operationId':opid,
                    'reservationId':claim['lease'].view['operation']['reservation_id'],
                    'profileVersion':claim['receipt']['profileVersion'],'profileDigest':claim['receipt']['profileDigest'],
                    'beforeConfigDigest':J.fingerprint(claim['before']),'afterConfigDigest':J.fingerprint(candidate),
                    'sourceBindingDigest':claim['lease'].context['observation']['source_binding_digest'],
                    'state':'PREPARED_CONFIG_ONLY_SOURCE_UNCHANGED'}
                _write_exclusive(self.gate.root/'operations'/('prepared-'+opid+'.json'),receipt)
                lease=claim['lease'];self.gate._local.preparation_ack=_PolicyAckFence(self,key)
                try:
                    lease.view=lease.store.record_ack(self.gate.scope,lease.handle,'prepare',
                        J.fingerprint(receipt),expected_version=lease.view['operation']['version'])
                finally:self.gate._local.preparation_ack=None
            return copy.deepcopy(receipt)
        except BaseException as error:
            try:claim['lease'].close()
            except BaseException:error.add_note('RESOURCE_PREPARATION_CLOSE_UNCONFIRMED')
            raise J.OperationCommitUncertain('RESOURCE_PREPARATION_CONFIG_UNCERTAIN_KEEP_ALL_EVIDENCE') from error
        finally:
            self.gate._local.preparation_reload=None
            self.gate._local.preparation_ack=None
            if directory is not None:os.close(directory)
            # Never restore config, remove attempts/temporaries or retry unknown.

    def _begin_start(self,key):
        """Private durable STARTING intent; not a started/native ACK."""
        from .worker_resource_native import _StartPermit,_StartProbe,_StartBoundary,qualify_start
        claim=self._current(key);lease=claim['lease']
        need(not claim.get('start_attempted',False),'RESOURCE_NATIVE_START_ALREADY_ATTEMPTED')
        try:
            with self.gate.admission():
                from .worker_host_job import require_idle
                require_idle(self.gate)
                op=lease.view['operation']
                claim['prepared_receipt_digest']=op['last_receipt_digest']
                probe=_StartProbe(self,key,op['id'],op['reservation_id'],op['reserved_sid'],op['version'])
                qualify_start(self.gate,probe,allow_running_source=True)
                claim['start_attempted']=True
                lease.view=lease.store.begin_effect(self.gate.scope,lease.handle,'start',expected_version=op['version'])
                op=lease.view['operation']
                permit=_StartPermit(self,key,op['id'],op['reservation_id'],op['reserved_sid'],op['version'])
                claim['start_permit']=permit
                _write_exclusive(self.gate.root/'operations'/('start-attempt-'+op['id']+'.json'),
                    {'schema':'reverie-resource-start-intent-v1','operationId':op['id'],
                     'reservationId':op['reservation_id'],'targetSid':op['reserved_sid'],
                     'nativeBaselineDigest':J.fingerprint(claim['native_baseline']),'state':'STARTING'})
                self.gate._local.start_boundary=_StartBoundary(permit,allow_running_source=True)
            return permit
        except BaseException as error:
            try:lease.close()
            except BaseException:error.add_note('RESOURCE_NATIVE_CLAIM_CLOSE_UNCONFIRMED')
            raise J.OperationCommitUncertain('RESOURCE_NATIVE_START_INTENT_UNCERTAIN_KEEP_CLAIM') from error

    def _stop_source_once(self,key,permit):
        """Use canonical immutable-CID stop; replacement still does not exist."""
        from .worker_resource_native import _StartBoundary,qualify_start
        claim=self._current(key);lease=claim['lease']
        need(claim.get('start_permit') is permit and not claim.get('source_stop_attempted',False),
             'RESOURCE_NATIVE_SOURCE_STOP_ALREADY_ATTEMPTED')
        try:
            with self.gate.admission():
                state=qualify_start(self.gate,permit,allow_running_source=True)
                claim['source_stop_attempted']=True
                op=lease.view['operation']
                _write_exclusive(self.gate.root/'operations'/('source-stop-attempt-'+op['id']+'.json'),
                    {'schema':'reverie-resource-source-stop-v1','operationId':op['id'],
                     'sourceId':claim['source_id'],'state':'STOP_REQUESTED'})
                if state['state']=='SOURCE_RUNNING_NO_LAUNCH':
                    name=claim['native_baseline']['sourceRow']['Name'].removeprefix('/')
                    original=claim['native_baseline']['native']
                    self.gate._local.protected_source_stop = permit
                    try:
                        self.broker.stop(name,expected_id=claim['source_id'],retain_storage=True,
                            expected_process={'pid':original['pid'],'start':original['start']})
                    finally:
                        self.gate._local.protected_source_stop = None
                qualify_start(self.gate,permit)
                released=self.broker.release_storage(claim['source_paths'].session)
                need(released is True,'RESOURCE_NATIVE_STORAGE_RELEASE_UNCONFIRMED')
                self.gate._local.start_boundary=_StartBoundary(permit)
            claim['source_stop_completed']=True
            return {'state':'SOURCE_RELEASED_TARGET_NOT_CREATED','operationId':op['id'],
                    'capacityRetained':True,'retryAllowed':False,'verified':False}
        except BaseException as error:
            try:lease.close()
            except BaseException:error.add_note('RESOURCE_NATIVE_CLAIM_CLOSE_UNCONFIRMED')
            raise J.OperationCommitUncertain('RESOURCE_NATIVE_SOURCE_STOP_UNCERTAIN_KEEP_CLAIM') from error

    def close(self):
        for claim in self._claims.values():claim['lease'].close()
