"""Fixed native resource observations and private one-operation launch fencing.

Not an owner authorizer, RPC provider or enabled actor. Every observation uses
its installed Gate's real engine/kernel producer. No request supplies receipts,
PIDs, paths, limits or a callback. The future authenticated server bootstrap is
still required before exposing any mutation entry.
"""
import copy
from dataclasses import dataclass
import os
from pathlib import Path
import stat
import threading

from . import laptop_resource_operations as J
from .worker_resources import RESOURCE_FIELDS,effective_config,policy_digest
from .worker_storage import read_metadata,storage_paths,storage_start_allowed
from . import worker_resource_reservations as R


def _account_mounts(row):
    """Selected account directory references only, never credential contents."""
    mounts=[];seen=set()
    for mount in row['Mounts']:
        destination=mount.get('Destination','')
        if not any(destination.startswith(prefix) for prefix in
                   ('/instances/default/accounts/','/instances/default/console/accounts/')):continue
        source=mount.get('Source')
        R.need(type(source) is str and Path(source).is_absolute() and Path(source).resolve()==Path(source) and
               '..' not in Path(destination).parts and destination not in seen and
               mount.get('Type')=='bind' and mount.get('RW') is True,
               'RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED')
        seen.add(destination);mounts.append({'source':source,'destination':destination,
                                            'identity':R._identity(source)})
    return sorted(mounts,key=lambda item:item['destination'])


def _request_accounts(gate,claim,request):
    """The actual canonical J environment must select the same account mounts."""
    from .worker import account_mounts
    arguments=account_mounts(gate.broker.config,request['env']);selected=[]
    R.need(len(arguments)%2==0,'RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED')
    for flag,value in zip(arguments[::2],arguments[1::2]):
        fields=value.split(',')
        R.need(flag=='--mount' and len(fields)==3 and fields[0]=='type=bind' and
               fields[1].startswith('src=') and fields[2].startswith('dst='),
               'RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED')
        source,destination=fields[1][4:],fields[2][4:]
        selected.append({'source':source,'destination':destination,'identity':R._identity(source)})
    R.need(sorted(selected,key=lambda item:item['destination'])==claim['native_baseline']['accounts'],
           'RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED')


def capture_original(gate,context,paths):
    """Capture recoverable raw facts before claim admission's terminal check."""
    observed=context['observation'];rows=context['native']
    selected=[row for row in rows if (row.get('Config',{}).get('Labels') or {}).get('reverie.worker')==
              gate.broker.config['deployment'] and (row['Config']['Labels'] or {}).get('reverie.session')==paths.session]
    R.need(len(selected)==1,'RESOURCE_NATIVE_SOURCE_REQUIRED');row=selected[0]
    _,native=gate.native.limits(row);storage=gate.native.storage(row,paths)
    total,budget,site,commitments=gate.native.capacity(rows,gate.option)
    R.need(J.fingerprint({'employee':context['employee'],'native':native,'storage':storage,
           'profile':context['profile']})==observed['source_binding_digest'],'RESOURCE_NATIVE_SOURCE_CHANGED')
    R.need(J.fingerprint({'pool':observed['pool_id'],'budget':budget,'site':site,
           'reserve':gate.option['hostReserveMiB'],'commitments':sorted(commitments,key=lambda r:r['containerId'])})==
           observed['pool_revision_digest'],'RESOURCE_NATIVE_CAPACITY_CHANGED')
    group=R.CGROUP/native['cgroup'];identity=group.lstat()
    R.need(stat.S_ISDIR(identity.st_mode),'RESOURCE_NATIVE_CGROUP_REQUIRED')
    accounts=_account_mounts(row)
    for mount in accounts:
        R.need(R._identity(R.PROC/str(native['pid'])/'root'/mount['destination'].lstrip('/'))==mount['identity'],
               'RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED')
    return {'schema':'reverie-resource-native-baseline-v1','sourceRow':copy.deepcopy(row),
        'native':native,'storage':storage,'site':site,'commitments':commitments,
        'cgroupIdentity':[identity.st_dev,identity.st_ino],'total':total,'budget':budget,'accounts':accounts}


@dataclass(frozen=True)
class _StartPermit:
    owner: object
    key: object
    operation_id: str
    reservation_id: str
    target_sid: str
    version: int


@dataclass(frozen=True)
class _StartProbe:
    owner: object
    key: object
    operation_id: str
    reservation_id: str
    target_sid: str
    version: int


@dataclass(frozen=True)
class _RuntimePermit:
    owner: object
    key: object
    operation_id: str
    reservation_id: str
    target_sid: str
    version: int


@dataclass(frozen=True,eq=False)
class _RuntimeJournalFence:
    owner: object
    key: object
    permit: object
    document: dict
    facts: dict
    readiness: object = None


@dataclass(frozen=True)
class _StartBoundary:
    permit: object
    allow_running_source: bool = False


@dataclass(frozen=True, eq=False)
class _CanonicalLaunch:
    """Registered join with the normal broker pipeline, never a wire permit."""
    owner: object
    key: object
    permit: object
    request_digest: str


def bind_launch(owner, key, request):
    from .worker import validate_request
    claim = owner._current(key)
    permit = claim.get('start_permit')
    R.need(permit is not None and not claim.get('canonical_launch'),
           'RESOURCE_NATIVE_LAUNCH_ALREADY_BOUND')
    selected = validate_request(copy.deepcopy(request), owner.broker.config)
    R.need(selected['sessionId'] == permit.target_sid and not selected.get('attachOnly'),
           'RESOURCE_NATIVE_FRESH_LAUNCH_REQUIRED')
    with owner.gate.admission():
        qualify_start(owner.gate, permit)
        _request_accounts(owner.gate,claim,selected)
        launch = _CanonicalLaunch(owner, key, permit, J.fingerprint(selected))
        R._write_exclusive(owner.gate.root / 'operations' / ('launch-request-' + permit.operation_id + '.json'),
            {'schema': 'reverie-resource-private-launch-join-v1', 'operationId': permit.operation_id,
             'reservationId': permit.reservation_id, 'targetSid': permit.target_sid,
             'requestDigest': launch.request_digest})
        claim['canonical_launch'] = launch
    return launch


def request_for_launch(broker, launch, request):
    R.need(type(launch) is _CanonicalLaunch and launch.owner.broker is broker and
           launch.owner.gate is broker.resource_reservations, 'RESOURCE_NATIVE_PRIVATE_JOIN_REQUIRED')
    claim = launch.owner._current(launch.key)
    R.need(claim.get('canonical_launch') is launch and
           J.fingerprint(request) == launch.request_digest and
           request['sessionId'] == launch.permit.target_sid and not request.get('attachOnly'),
           'RESOURCE_NATIVE_PRIVATE_REQUEST_CHANGED')
    R.need(not claim.get('canonical_launch_entered'), 'RESOURCE_NATIVE_PRIVATE_JOIN_ALREADY_ATTEMPTED')
    claim['canonical_launch_entered'] = True
    _request_accounts(broker.resource_reservations,claim,request)
    return launch.permit


def record_created(broker, launch, result):
    """Only the shared canonical engine create result supplies the new CID."""
    claim = _held_permit(broker.resource_reservations, launch.permit)
    R.need(claim.get('canonical_launch') is launch and claim.get('created_id') is None,
           'RESOURCE_NATIVE_CREATE_ALREADY_RECORDED')
    identity = result.stdout.strip()
    R.need(result.returncode == 0 and len(identity) == 64 and
           all(c in '0123456789abcdef' for c in identity) and
           identity not in {row['Id'] for row in claim['lease'].context['native']},
           'RESOURCE_NATIVE_CREATED_ID_REQUIRED')
    claim['created_id'] = identity
    R._write_exclusive(broker.resource_reservations.root / 'operations' /
        ('created-' + launch.permit.operation_id + '.json'),
        {'schema': 'reverie-resource-created-v1', 'operationId': launch.permit.operation_id,
         'containerId': identity, 'state': 'CREATED_NOT_STARTED'})


def record_cli_started(broker, launch):
    claim = _held_permit(broker.resource_reservations, launch.permit)
    R.need(claim.get('canonical_launch') is launch, 'RESOURCE_NATIVE_PRIVATE_JOIN_REQUIRED')
    facts = observe_created(broker.resource_reservations, launch.permit)
    R._write_exclusive(broker.resource_reservations.root / 'operations' /
        ('cli-started-' + launch.permit.operation_id + '.json'),
        {'schema': 'reverie-resource-canonical-cli-start-v1', 'operationId': launch.permit.operation_id,
         'requestDigest': launch.request_digest, 'nativeFacts': facts,
         'state': 'CANONICAL_CLI_STARTED_READINESS_NOT_VERIFIED'})
    claim['canonical_cli_started'] = copy.deepcopy(facts)


def record_canonical_released(broker,launch):
    """Publish only after the real admission/descriptor finalizers succeeded."""
    R.need(type(launch) is _CanonicalLaunch and launch.owner.broker is broker,
           'RESOURCE_NATIVE_PRIVATE_JOIN_REQUIRED')
    claim=launch.owner._claims.get(launch.key)
    R.need(claim is not None and claim.get('canonical_launch') is launch and
           claim.get('canonical_cli_started') is not None and not claim.get('canonical_released'),
           'RESOURCE_NATIVE_RELEASE_UNCONFIRMED')
    claim['canonical_released']=True
    event=claim.get('canonical_settled_event')
    if event is not None:event.set()


def record_canonical_closed(broker,launch):
    # This fixed finally-path only notifies the in-process service. It never
    # reopens a claim, retries native work, releases a lease or credits memory.
    if type(launch) is not _CanonicalLaunch or launch.owner.broker is not broker:return
    claim=launch.owner._claims.get(launch.key)
    if claim is None or claim.get('canonical_launch') is not launch:return
    if not claim.get('canonical_released'):claim['canonical_error']=True
    event=claim.get('canonical_settled_event')
    if event is not None:event.set()


def _claim(gate,permit):
    R.need(type(permit) in (_StartPermit,_StartProbe,_RuntimePermit) and permit.owner.gate is gate,'RESOURCE_NATIVE_PERMIT_REQUIRED')
    claim=permit.owner._current(permit.key);lease=claim['lease'];op=lease.view['operation']
    if type(permit) is _StartPermit:
        R.need(claim.get('start_permit') is permit,'RESOURCE_NATIVE_PERMIT_CHANGED')
    if type(permit) is _RuntimePermit:
        R.need(claim.get('runtime_permit') is permit,'RESOURCE_NATIVE_PERMIT_CHANGED')
    R.need(lease.gate is gate and op['id']==permit.operation_id and op['reservation_id']==permit.reservation_id and
           op['reserved_sid']==permit.target_sid and op['version']==permit.version and
           (type(permit) is _StartPermit and op['state']=='STARTING' and permit.version==4 or
            type(permit) is _StartProbe and op['state']=='PREPARED' and permit.version==3 or
            type(permit) is _RuntimePermit and (op['state'],permit.version) in
               (('STARTED',5),('VERIFYING',6),('VERIFY_RECORDED',7),('COMPLETED',8))) and
           'native_baseline' in claim,'RESOURCE_NATIVE_PERMIT_CHANGED')
    return claim


def _old_pid_released(baseline):
    native=baseline['native']
    try:current=R._pid(native['pid'])
    except FileNotFoundError:return
    R.need(current!=native['start'],'RESOURCE_NATIVE_OLD_PROCESS_ALIVE')


def _old_released(gate,baseline,row):
    R.need(row['State']=={'Running':False,'Pid':0},'RESOURCE_NATIVE_OLD_LAPTOP_RUNNING')
    _old_pid_released(baseline)
    leaf=R.CGROUP/baseline['native']['cgroup']
    if os.path.lexists(leaf):
        identity=leaf.lstat()
        R.need(stat.S_ISDIR(identity.st_mode) and [identity.st_dev,identity.st_ino]==baseline['cgroupIdentity'],
               'RESOURCE_NATIVE_OLD_CGROUP_CHANGED')
        facts={}
        for line in R._read(leaf/'cgroup.events',4096).splitlines():
            fields=line.split()
            R.need(len(fields)==2 and fields[0] not in facts and fields[1].isascii() and fields[1].isdecimal(),
                   'RESOURCE_NATIVE_OLD_CGROUP_UNKNOWN')
            facts[fields[0]]=int(fields[1])
        R.need(facts.get('populated')==0,'RESOURCE_NATIVE_OLD_CGROUP_POPULATED')
    _old_pid_released(baseline)


def qualify_start(gate,permit,*,allow_running_source=False,require_storage_lease=False):
    """Read-only terminal native facts; no owner/launch authority is minted."""
    from .worker_resource_preparation import _document,_policy_current
    claim=_claim(gate,permit);lease=claim['lease'];context=lease.context;baseline=claim['native_baseline']
    document,signature=_document(gate)
    R.need(document['operations'].get(permit.operation_id)==lease.view['operation'],'RESOURCE_NATIVE_CLAIM_CHANGED')
    rows=gate._guard();old=[row for row in rows if row['Id']==baseline['native']['containerId']]
    R.need(len(old)==1,'RESOURCE_NATIVE_OLD_CID_REQUIRED')
    expected=copy.deepcopy(baseline['sourceRow']);expected['State']=copy.deepcopy(old[0]['State'])
    R.need(old[0]==expected,'RESOURCE_NATIVE_OLD_BINDING_CHANGED')
    running=old[0]['State']=={'Running':True,'Pid':baseline['native']['pid']}
    if running:
        R.need(allow_running_source,'RESOURCE_NATIVE_OLD_LAPTOP_RUNNING')
        _,native=gate.native.limits(old[0]);storage=gate.native.storage(old[0],claim['source_paths'])
        R.need(native==baseline['native'] and storage==baseline['storage'],'RESOURCE_NATIVE_OLD_BINDING_CHANGED')
    else:_old_released(gate,baseline,old[0])
    original={row['Id']:row for row in context['native'] if row['Id']!=old[0]['Id']}
    peers={row['Id']:row for row in rows if row['Id']!=old[0]['Id']}
    R.need(peers==original,'RESOURCE_NATIVE_PEER_OR_TARGET_CHANGED')
    total,budget,site,commitments=gate.native.capacity(rows,gate.option)
    R.need(site==baseline['site'] and budget==baseline['budget'],'RESOURCE_NATIVE_CAPACITY_CHANGED')
    expected_commitments=[row for row in baseline['commitments'] if running or row['containerId']!=old[0]['Id']]
    R.need(sorted(commitments,key=lambda r:r['containerId'])==sorted(expected_commitments,key=lambda r:r['containerId']),
           'RESOURCE_NATIVE_COMMITMENTS_CHANGED')
    retained=0
    for op in gate.active_operations(document):
        if op['id']==permit.operation_id:continue
        observed=gate.observe(op['scope'],op['request']['pool_id'],op['request']['employee_id'])
        R.need(observed['source_binding_digest']==op['observation']['source_binding_digest'] and
               observed['current_memory_bytes']==op['observation']['current_memory_bytes'],
               'RESERVATION_RECONCILIATION_REQUIRED')
        retained+=J.wide(op['delta_bytes'])
    # The own positive hold is consumed once by this exact candidate charge;
    # it is not released for unrelated admissions or turned into general credit.
    candidate=J.memory(lease.view['operation']['request']['requested_memory_bytes'])
    if not running:
        from .worker_capacity_policy import pool_headroom_fits
        R.need(pool_headroom_fits(budget_bytes=budget,committed_bytes=total,
               retained_bytes=retained,candidate_bytes=candidate),'RESERVATION_CAPACITY_EXHAUSTED')
    paths=storage_paths(gate.broker.config,permit.target_sid)
    R.need(paths.kind=='employee' and paths.identity==context['profile']['binding']['employee_id'] and
           storage_start_allowed(gate.broker.config,paths),'RESOURCE_NATIVE_TARGET_BINDING_CHANGED')
    for destination,source in [('/home/agent',paths.home),('/nix',paths.nix),('/scratch',paths.scratch)]:
        R.need(R._identity(source)==baseline['storage'][destination],'RESOURCE_NATIVE_STORAGE_CHANGED')
    if require_storage_lease:
        held=getattr(gate.broker,'storage_leases',{}).get(permit.target_sid)
        R.need(held is not None and held[1]==paths,'RESOURCE_NATIVE_STORAGE_LEASE_REQUIRED')
    _terminal(gate,claim,rows,signature,paths)
    return {'state':'SOURCE_RUNNING_NO_LAUNCH' if running else 'SOURCE_RELEASED_TARGET_NOT_CREATED',
            'operationId':permit.operation_id,'targetSid':permit.target_sid,'capacityRetained':True,
            'retryAllowed':False,'verified':False}


def assert_employee_current(claim,company):
    """Only thread bookkeeping may advance after the real canonical CLI start.

    All selected recipe settings, owner intent and employee/transport fields
    remain exact. This does not infer conversation or handoff continuity.
    """
    eid=claim['lease'].context['observation']['employee_id']
    selected=[row for row in company['employees'] if row.get('id')==eid]
    R.need(len(selected)==1,'RESOURCE_NATIVE_TARGET_BINDING_CHANGED')
    expected=copy.deepcopy(claim['receipt']['afterEmployee']);actual=copy.deepcopy(selected[0])
    if claim.get('canonical_cli_started'):
        for value in (actual,expected):
            recipe=value.get('runtimeRecipe')
            if recipe is not None:
                R.need(type(recipe) is dict,'RESOURCE_NATIVE_TARGET_BINDING_CHANGED')
                threads=recipe.get('runtimeThreads',{})
                R.need(type(threads) is dict and len(threads)<=256 and all(
                    type(k) is str and 0<len(k)<=16384 and '\0' not in k and
                    type(v) is str and 0<len(v)<=16384 and '\0' not in v for k,v in threads.items()),
                    'RESOURCE_NATIVE_TARGET_THREAD_METADATA')
                recipe.pop('runtimeThreads',None)
    R.need(actual==expected,'RESOURCE_NATIVE_TARGET_BINDING_CHANGED')


def _terminal(gate,claim,rows,signature,paths):
    from .worker_resource_preparation import _policy_current
    context=claim['lease'].context
    for account in claim['native_baseline']['accounts']:
        R.need(R._identity(account['source'])==account['identity'],'RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED')
    gate.native.custody(claim['policy_path'].parent,claim['policy_path'])
    R.need(gate._guard()==rows,'RESOURCE_NATIVE_INVENTORY_CHANGED')
    _policy_current(gate,claim)
    R.need(gate.broker.config==claim['candidate'],'RESOURCE_NATIVE_CONFIG_CHANGED')
    opid=claim['lease'].view['operation']['id']
    phase=gate.root/'operations'/('publication-'+opid+'.json')
    R.need(R._file(phase,gate.broker.config['uid'])==claim['receipt'],'RESOURCE_NATIVE_PHASE_CHANGED')
    stamp=phase.lstat()
    R.need((stamp.st_dev,stamp.st_ino,stamp.st_size,stamp.st_mtime_ns,stamp.st_ctime_ns)==claim['phase_signature'],
           'RESOURCE_NATIVE_PHASE_CHANGED')
    prepared=R._file(gate.root/'operations'/('prepared-'+opid+'.json'),gate.broker.config['uid'])
    R.need(J.fingerprint(prepared)==claim.get('prepared_receipt_digest') and prepared['operationId']==opid and
           prepared['reservationId']==claim['lease'].view['operation']['reservation_id'] and
           prepared['profileDigest']==J.fingerprint(context['profile']) and
           prepared['afterConfigDigest']==J.fingerprint(claim['candidate']), 'RESOURCE_NATIVE_PREPARATION_CHANGED')
    if signature is not None:
        current=(gate.root/'operations/operations.json').lstat()
        R.need((current.st_dev,current.st_ino,current.st_size,current.st_mtime_ns,current.st_ctime_ns)==signature,
               'RESOURCE_NATIVE_CLAIM_CHANGED')
    R.need(gate._profile(context['observation']['employee_id'])==context['profile'],'RESOURCE_NATIVE_PROFILE_CHANGED')
    company=read_metadata(gate.broker.config['companyFile'],gate.broker.config['uid'])
    assert_employee_current(claim,company)
    R.need(storage_paths(gate.broker.config,paths.session)==paths and storage_start_allowed(gate.broker.config,paths),
           'RESOURCE_NATIVE_TARGET_BINDING_CHANGED')
    from .worker_resource_preparation import _owner_live
    _owner_live(claim)


def finish_start_boundary(gate,boundary):
    R.need(type(boundary) is _StartBoundary and type(boundary.allow_running_source) is bool,
           'RESOURCE_NATIVE_BOUNDARY_REQUIRED')
    claim=_claim(gate,boundary.permit)
    if claim.get('created_id') is not None:
        return observe_created(gate,boundary.permit)
    return qualify_start(gate,boundary.permit,allow_running_source=boundary.allow_running_source)


def begin_permit(gate,permit,sid):
    from .worker_host_job import require_idle
    require_idle(gate)
    R.need(type(permit) is _StartPermit and sid==permit.target_sid,'RESOURCE_NATIVE_PERMIT_REQUIRED')
    claim=_claim(gate,permit)
    R.need(not claim.get('permit_used',False),'RESOURCE_NATIVE_PERMIT_ALREADY_ATTEMPTED')
    claim['permit_used']=True
    claim['permit_admission_fd']=gate._local.fd;claim['permit_thread']=threading.get_ident()
    R._write_exclusive(gate.root/'operations'/('launch-attempt-'+permit.operation_id+'.json'),
        {'schema':'reverie-resource-canonical-launch-v1','operationId':permit.operation_id,
         'reservationId':permit.reservation_id,'targetSid':sid,'state':'CREATE_ADMISSION_ATTEMPTED'})


def _held_permit(gate,permit):
    claim=_claim(gate,permit)
    R.need(claim.get('permit_used') is True and claim.get('permit_admission_fd')==gate._local.fd and
           claim.get('permit_thread')==threading.get_ident(),'RESOURCE_NATIVE_PERMIT_LOCK_REQUIRED')
    return claim


def allow_reserved_launch(gate,permit,sid):
    R.need(type(permit) is _StartPermit and sid==permit.target_sid,'RESOURCE_NATIVE_PERMIT_REQUIRED')
    _held_permit(gate,permit)
    qualify_start(gate,permit)


def allow_source_stop(gate, name, expected_id, expected_process):
    permit = getattr(gate._local, 'protected_source_stop', None)
    R.need(type(permit) is _StartPermit,
           'RESOURCE_OPERATION_STOP_REQUIRES_PROTECTED_RECONCILIATION')
    claim = _claim(gate, permit); baseline = claim['native_baseline']; native = baseline['native']
    R.need(claim.get('source_stop_attempted') is True and not claim.get('source_stop_invoked') and
           name in (claim['source_id'], baseline['sourceRow']['Name'].removeprefix('/')) and
           expected_id == claim['source_id'] and expected_process == {'pid': native['pid'], 'start': native['start']},
           'RESOURCE_OPERATION_STOP_REQUIRES_PROTECTED_RECONCILIATION')
    qualify_start(gate, permit, allow_running_source=True)
    claim['source_stop_invoked'] = True


def creation_for_permit(gate,permit,sid,resources):
    R.need(type(permit) is _StartPermit and sid==permit.target_sid,'RESOURCE_NATIVE_PERMIT_REQUIRED')
    claim=_held_permit(gate,permit);profile=claim['lease'].context['profile']
    R.need(all(resources[key]==profile['resources'][key] for key in RESOURCE_FIELDS),
           'RESOURCE_NATIVE_TARGET_POLICY_CHANGED')
    qualify_start(gate,permit,require_storage_lease=True)


def observe_created(gate,permit,*,_locked=None):
    """Real resource facts only; not CLI readiness, owner auth or credit."""
    from .worker_resource_preparation import _document
    claim=_claim(gate,permit);lease=claim['lease'];context=lease.context;baseline=claim['native_baseline']
    created=claim.get('created_id')
    R.need(type(created) is str and len(created)==64 and all(c in '0123456789abcdef' for c in created) and
           created not in {row['Id'] for row in context['native']},'RESOURCE_NATIVE_CREATED_ID_REQUIRED')
    if _locked is None:document,signature=_document(gate)
    else:
        R.need(type(_locked) is _RuntimeJournalFence and _locked.owner is permit.owner and
               _locked.key is permit.key and _locked.permit is permit and
               claim.get('runtime_journal_fence') is _locked and
               getattr(gate._local,'runtime_ack',None) is _locked,'RESOURCE_NATIVE_JOURNAL_FENCE_REQUIRED')
        # The real OperationStore already holds/validates its journal FD/flock.
        # Reopening that lock here would deadlock; it supplies the same durable
        # old operation and validates the new journal stamp after this guard.
        document,signature=_locked.document,None
    R.need(document['operations'].get(permit.operation_id)==lease.view['operation'],'RESOURCE_NATIVE_CLAIM_CHANGED')
    rows=gate._guard();old=[row for row in rows if row['Id']==baseline['native']['containerId']]
    target=[row for row in rows if row['Id']==created]
    R.need(len(old)==1 and len(target)==1,'RESOURCE_NATIVE_CID_REQUIRED')
    previous=copy.deepcopy(baseline['sourceRow']);previous['State']={'Running':False,'Pid':0}
    R.need(old[0]==previous,'RESOURCE_NATIVE_OLD_BINDING_CHANGED');_old_released(gate,baseline,old[0])
    others={row['Id']:row for row in rows if row['Id'] not in (created,old[0]['Id'])}
    expected={row['Id']:row for row in context['native'] if row['Id']!=old[0]['Id']}
    R.need(others==expected,'RESOURCE_NATIVE_PEER_OR_TARGET_CHANGED')
    row=target[0];labels=row.get('Config',{}).get('Labels') or {};profile=context['profile']
    accounts=_account_mounts(row)
    R.need(accounts==baseline['accounts'],'RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED')
    resources=effective_config(gate.broker.config,permit.target_sid)
    R.need(row['Image']==claim['candidate']['image'] and
           row['Name']=='/'+gate.broker.config['deployment']+'-agent-'+permit.target_sid and
           labels.get('reverie.worker')==gate.broker.config['deployment'] and
           labels.get('reverie.session')==permit.target_sid and
           labels.get('reverie.employee')==profile['binding']['employee_id'] and
           labels.get('reverie.worker-policy')==policy_digest(gate.broker.config,permit.target_sid) and
           all(resources[k]==profile['resources'][k] for k in RESOURCE_FIELDS),'RESOURCE_NATIVE_TARGET_POLICY_CHANGED')
    memory,native=gate.native.limits(row)
    for account in accounts:
        R.need(R._identity(R.PROC/str(native['pid'])/'root'/account['destination'].lstrip('/'))==account['identity'],
               'RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED')
    R.need(memory==resources['memoryMiB']*J.MIB and native['tasks']==resources['pidsLimit'] and
           native['nanoCpus']==int(resources['cpus']*1000000000),'RESOURCE_NATIVE_TARGET_POLICY_CHANGED')
    paths=storage_paths(gate.broker.config,permit.target_sid)
    storage=gate.native.storage(row,paths)
    R.need(storage==baseline['storage'],'RESOURCE_NATIVE_STORAGE_CHANGED')
    temporary=Path(paths.scratch)/'tmp'
    mounts=[mount for mount in row['Mounts'] if mount.get('Destination')=='/tmp']
    R.need(len(mounts)==1 and mounts[0].get('Type')=='bind' and mounts[0].get('Source')==str(temporary) and
           mounts[0].get('RW') is True and R._identity(temporary)==R._identity(R.PROC/str(native['pid'])/'root/tmp'),
           'RESOURCE_NATIVE_TEMP_BINDING_CHANGED')
    total,budget,site,commitments=gate.native.capacity(rows,gate.option)
    R.need(site==baseline['site'] and budget==baseline['budget'],'RESOURCE_NATIVE_CAPACITY_CHANGED')
    peers=[record for record in commitments if record['containerId']!=created]
    expected_peers=[record for record in baseline['commitments'] if record['containerId']!=old[0]['Id']]
    R.need(sorted(peers,key=lambda r:r['containerId'])==sorted(expected_peers,key=lambda r:r['containerId']),
           'RESOURCE_NATIVE_COMMITMENTS_CHANGED')
    retained=0
    for op in gate.active_operations(document):
        if op['id']==permit.operation_id:continue
        value=gate.observe(op['scope'],op['request']['pool_id'],op['request']['employee_id'])
        R.need(value['source_binding_digest']==op['observation']['source_binding_digest'] and
               value['current_memory_bytes']==op['observation']['current_memory_bytes'],
               'RESERVATION_RECONCILIATION_REQUIRED')
        retained+=J.wide(op['delta_bytes'])
    from .worker_capacity_policy import pool_headroom_fits
    R.need(pool_headroom_fits(budget_bytes=budget,committed_bytes=total,retained_bytes=retained,candidate_bytes=0),
           'RESERVATION_CAPACITY_EXHAUSTED')
    _terminal(gate,claim,rows,signature,paths)
    return {'schema':'reverie-resource-running-facts-v1','operationId':permit.operation_id,
        'container':native,'storage':storage,'state':'RUNNING_CONTAINER_RESOURCE_FACTS_ONLY',
        'cliReadyVerified':False,'capacityRetained':True,'retryAllowed':False,'verified':False}


def _ack_runtime_current(gate,fence):
    R.need(type(fence) is _RuntimeJournalFence and fence.owner.gate is gate,
           'RESOURCE_NATIVE_JOURNAL_FENCE_REQUIRED')
    if fence.readiness is not None:fence.readiness.assert_current()
    R.need(observe_created(gate,fence.permit,_locked=fence)==fence.facts,
           'RESOURCE_NATIVE_ACK_FACTS_CHANGED')


def _runtime_change(owner,key,effect,receipt=None,*,readiness=None):
    """Fixed native facts at every actual journal commit/finalizer boundary."""
    from .worker_resource_preparation import _document
    claim=owner._current(key);lease=claim['lease']
    permit=claim.get('runtime_permit') or claim.get('start_permit')
    facts=observe_created(owner.gate,permit);document,_signature=_document(owner.gate)
    R.need(document['operations'].get(permit.operation_id)==lease.view['operation'],
           'RESOURCE_NATIVE_CLAIM_CHANGED')
    fence=_RuntimeJournalFence(owner,key,permit,document,facts,readiness)
    claim['runtime_journal_fence']=fence;owner.gate._local.runtime_ack=fence
    try:
        if receipt is None:
            lease.view=lease.store.begin_effect(owner.gate.scope,lease.handle,effect,
                                                expected_version=lease.view['operation']['version'])
        else:
            lease.view=lease.store.record_ack(owner.gate.scope,lease.handle,effect,J.fingerprint(receipt),
                                              expected_version=lease.view['operation']['version'])
    finally:
        owner.gate._local.runtime_ack=None;claim.pop('runtime_journal_fence',None)
    op=lease.view['operation']
    permit=_RuntimePermit(owner,key,op['id'],op['reservation_id'],op['reserved_sid'],op['version'])
    claim['runtime_permit']=permit
    owner.gate._local.start_boundary=_StartBoundary(permit)
    return facts


def acknowledge_started(owner,key):
    """The real canonical pipeline has created/started the CLI. No readiness,
    completion, capacity credit or reusable creation permission follows.
    """
    claim=owner._current(key);lease=claim['lease']
    R.need(claim.get('canonical_released') is True and claim.get('canonical_cli_started') is not None and
           not claim.get('started_ack_attempted'),'RESOURCE_NATIVE_CANONICAL_RELEASE_REQUIRED')
    claim['started_ack_attempted']=True
    try:
        with owner.gate.admission():
            facts=observe_created(owner.gate,claim['start_permit'])
            R.need(facts==claim['canonical_cli_started'],'RESOURCE_NATIVE_CANONICAL_INCARCATION_CHANGED')
            op=lease.view['operation']
            receipt={'schema':'reverie-resource-started-v1','operationId':op['id'],
                'reservationId':op['reservation_id'],'nativeFacts':facts,
                'state':'STARTED_READINESS_NOT_VERIFIED','capacityRetained':True}
            R._write_exclusive(owner.gate.root/'operations'/('started-'+op['id']+'.json'),receipt)
            _runtime_change(owner,key,'start',receipt)
            claim['started_facts']=copy.deepcopy(facts)
        return copy.deepcopy(receipt)
    except BaseException as error:
        try:lease.close()
        except BaseException:error.add_note('RESOURCE_NATIVE_CLAIM_CLOSE_UNCONFIRMED')
        raise J.OperationCommitUncertain('RESOURCE_NATIVE_START_ACK_UNCERTAIN_KEEP_CLAIM') from error


def begin_verification(owner,key):
    claim=owner._current(key);lease=claim['lease']
    R.need(not claim.get('verify_attempted'),'RESOURCE_NATIVE_VERIFY_ALREADY_ATTEMPTED')
    claim['verify_attempted']=True
    try:
        with owner.gate.admission():
            R.need(observe_created(owner.gate,claim['runtime_permit'])==claim['started_facts'],
                   'RESOURCE_NATIVE_STARTED_FACTS_CHANGED')
            _runtime_change(owner,key,'verify')
        return {'state':'VERIFYING','capacityRetained':True}
    except BaseException as error:
        try:lease.close()
        except BaseException:error.add_note('RESOURCE_NATIVE_CLAIM_CLOSE_UNCONFIRMED')
        raise J.OperationCommitUncertain('RESOURCE_NATIVE_VERIFY_INTENT_UNCERTAIN_KEEP_CLAIM') from error


def acknowledge_verified(owner,key,readiness):
    """Record actual normal-session readiness plus current kernel facts.
    This remains VERIFY_RECORDED with the complete positive hold retained.
    """
    from .worker_resource_actor import _ReadinessProof
    claim=owner._current(key);lease=claim['lease']
    R.need(type(readiness) is _ReadinessProof and readiness.connection.owner is owner and
           readiness.selected['key'] is key and claim.get('readiness_proof') is readiness and
           readiness.stage=='verify' and not claim.get('verify_ack_attempted'),
           'RESOURCE_NATIVE_REGISTERED_READINESS_REQUIRED')
    claim['verify_ack_attempted']=True
    try:
        with owner.gate.admission():
            readiness.assert_current()
            facts=observe_created(owner.gate,claim['runtime_permit'])
            R.need(facts==claim['started_facts'],'RESOURCE_NATIVE_STARTED_FACTS_CHANGED')
            op=lease.view['operation']
            receipt={'schema':'reverie-resource-verified-v1','operationId':op['id'],
                'reservationId':op['reservation_id'],'nativeFacts':facts,
                'normalSession':copy.deepcopy(readiness.proof),'state':'VERIFY_RECORDED_CAPACITY_RETAINED',
                'capacityRetained':True}
            R._write_exclusive(owner.gate.root/'operations'/('verified-'+op['id']+'.json'),receipt)
            _runtime_change(owner,key,'verify',receipt,readiness=readiness)
            claim['verified_receipt']=receipt
        return copy.deepcopy(receipt)
    except BaseException as error:
        try:lease.close()
        except BaseException:error.add_note('RESOURCE_NATIVE_CLAIM_CLOSE_UNCONFIRMED')
        raise J.OperationCommitUncertain('RESOURCE_NATIVE_VERIFY_ACK_UNCERTAIN_KEEP_CLAIM') from error
