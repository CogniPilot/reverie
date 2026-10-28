"""Read-only recognition of an already settled canonical resource operation.

This never opens an old effect handle, changes an operation, releases a hold,
clears a pending marker or starts a process. Unknown/nonterminal outcomes remain
fenced. The first supported case keeps the exact approved target current.
"""
import copy
import os
from pathlib import Path
import stat
import time

from . import laptop_resource_operations as J
from . import worker_resource_reservations as R
from . import worker_resource_finalization as S
from .worker_resource_preparation import _document
from .worker_storage import read_metadata, storage_paths, storage_start_allowed
from .worker_resources import effective_config, policy_digest, RESOURCE_FIELDS

_MINT=object()
STABLE=('id','owner','employeeId','oldSession','newSession','fromAccount','toAccount','purpose',
        'runtimeDigest','requestDigest','resourceIntent','resourceOwnerScope','sourceStopRequested','sourceCleanupVerified')


def _stamp(path):
    info=path.lstat()
    R.need(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1 and
           not info.st_mode&0o022,'RESOURCE_HISTORY_METADATA_CHANGED')
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,
            info.st_size,info.st_mtime_ns,info.st_ctime_ns)


class _Inspection:
    def __init__(self,token,gate,authority,opid):
        from .worker_resource_actor import _OwnerOperation
        R.need(token is _MINT and type(authority) is _OwnerOperation and authority.approval is None and
               authority.connection.broker is gate.broker,'RESOURCE_HISTORY_CURRENT_OWNER_REQUIRED')
        self.gate,self.authority,self.opid=gate,authority,opid
        self.result=None;self.stamps=None;self.parents=None


def _metadata(context,expected=None):
    """All blocking readers/finalizers precede the last inode/ancestry bracket."""
    gate=context.gate;uid=gate.broker.config['uid'];opid=context.opid
    plan=Path(gate.broker.config['companyFile']).with_name('plan-moves.json')
    policy=Path(gate.broker.config_file)
    paths=[gate.root/'operations/operations.json',gate.root/'profiles/profiles.json',
           gate.root/'operations'/('settled-'+opid+'.json'),
           gate.root/'operations'/('verified-'+opid+'.json'),
           gate.root/'operations'/('publication-'+opid+'.json'),
           Path(gate.broker.config['companyFile']),policy,plan,R.marker(gate.broker.config)]
    stamps={path:_stamp(path) for path in paths}
    parents={parent for path in paths for parent in path.parents}
    R.need(len(parents)<=1024,'RESOURCE_HISTORY_ANCESTRY_BOUND')
    def directory(path):
        info=path.lstat();sticky=info.st_uid==0 and bool(info.st_mode&stat.S_ISVTX)
        R.need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0,uid) and
               (not info.st_mode&0o022 or sticky),'RESOURCE_HISTORY_ANCESTRY_CHANGED')
        return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)
    ancestry={path:directory(path) for path in parents}
    document=R._file(paths[0],uid);J.document(document)
    S.require_consistent_pending(gate,document)
    op=document['operations'].get(opid)
    R.need(op is not None and op['scope']==gate.scope and op['request']['employee_id']==context.authority.employee_id and
           S.completed(gate,op),'RESOURCE_HISTORY_SETTLED_OPERATION_REQUIRED')
    R.need(not any(other['id']!=opid and other['request']['employee_id']==context.authority.employee_id
                   for other in gate.active_operations(document)), 'RESOURCE_HISTORY_UNRESOLVED_EMPLOYEE')
    receipt=R._file(paths[2],uid);profile=gate._profile(context.authority.employee_id)
    R.need(profile==receipt['profile'],'RESOURCE_HISTORY_PROFILE_CHANGED')
    company=read_metadata(gate.broker.config['companyFile'],uid)
    employees=[e for e in company['employees'] if e.get('id')==context.authority.employee_id]
    R.need(len(employees)==1,'RESOURCE_HISTORY_EMPLOYEE_REQUIRED');employee=employees[0]
    R.need(employee.get('owner')==context.authority.owner and employee.get('sessionId')==op['reserved_sid'] and
           employee.get('sessionGeneration')==profile['binding']['target_generation'],
           'RESOURCE_HISTORY_CURRENT_TARGET_REQUIRED')
    selected_paths=storage_paths(gate.broker.config,op['reserved_sid'])
    R.need(selected_paths.kind=='employee' and selected_paths.identity==context.authority.employee_id and
           storage_start_allowed(gate.broker.config,selected_paths),'RESOURCE_HISTORY_CURRENT_TARGET_REQUIRED')
    records=read_metadata(plan,uid,limit=1024*1024)
    R.need(type(records) is list and len(records)<=100 and all(type(row) is dict for row in records) and
           len({row.get('id') for row in records})==len(records),'RESOURCE_HISTORY_PLAN_REQUIRED')
    matches=[row for row in records if row.get('id')==opid]
    R.need(len(matches)==1 and matches[0].get('phase') in ('completed','recovery-required') and
           matches[0].get('resourcePhase')=='verified' and
           {key:matches[0].get(key) for key in STABLE}==
           {key:receipt['planRecord'].get(key) for key in STABLE},'RESOURCE_HISTORY_PLAN_CHANGED')
    from .worker import validate_config
    R.need(validate_config(read_metadata(policy,uid,limit=J.MAX_BYTES))==gate.broker.config,
           'RESOURCE_HISTORY_POLICY_CHANGED')
    S._metadata(gate)
    publication=R._file(paths[4],uid)
    R.need(publication.get('operationId')==opid and publication.get('profileDigest')==J.fingerprint(profile),
           'RESOURCE_HISTORY_PUBLICATION_CHANGED')
    value={'operation':op,'receipt':receipt,'employee':employee,'profile':profile,
           'publication':publication,'document':document}
    if expected is not None:R.need(value==expected,'RESOURCE_HISTORY_FACTS_CHANGED')
    for path,signature in stamps.items():R.need(_stamp(path)==signature,'RESOURCE_HISTORY_METADATA_CHANGED')
    for path,signature in ancestry.items():R.need(directory(path)==signature,'RESOURCE_HISTORY_ANCESTRY_CHANGED')
    context.authority.assert_live()
    context.stamps,context.parents=stamps,ancestry
    return copy.deepcopy(value)


def finish_inspection(gate,context):
    R.need(type(context) is _Inspection and context.gate is gate and
           gate._local.completion_inspection is context,'RESOURCE_HISTORY_FIXED_INSPECTION_REQUIRED')
    context.authority.assert_current()
    document,_signature=_document(gate)  # Accepted reader/flock and all its finalizers.
    op=document['operations'].get(context.opid)
    R.need(op is not None and op['scope']==gate.scope and op['state']=='COMPLETED' and
           op['request']['employee_id']==context.authority.employee_id,
           'RESOURCE_HISTORY_SETTLED_OPERATION_REQUIRED')
    before=_metadata(context)
    R.need(before['document']==document,'RESOURCE_HISTORY_FACTS_CHANGED')
    rows=gate._guard();op=before['operation'];sid=op['reserved_sid'];eid=context.authority.employee_id
    target=[row for row in rows if (row.get('Config',{}).get('Labels') or {}).get('reverie.session')==sid]
    R.need(len(target)==1,'RESOURCE_HISTORY_NATIVE_TARGET_REQUIRED');row=target[0]
    labels=row['Config']['Labels'];resources=effective_config(gate.broker.config,sid)
    R.need(row['Id']==before['receipt']['nativeFacts']['container']['containerId'] and
           row['Name']=='/'+gate.broker.config['deployment']+'-agent-'+sid and
           row['Image']==gate.broker.config['image'] and
           labels.get('reverie.worker')==gate.broker.config['deployment'] and
           labels.get('reverie.employee')==eid and
           labels.get('reverie.worker-policy')==policy_digest(gate.broker.config,sid) and
           all(resources[k]==before['profile']['resources'][k] for k in RESOURCE_FIELDS),
           'RESOURCE_HISTORY_NATIVE_POLICY_CHANGED')
    _memory,native=gate.native.limits(row)
    R.need(native['memory']==resources['memoryMiB']*J.MIB and native['tasks']==resources['pidsLimit'] and
           native['nanoCpus']==int(resources['cpus']*1000000000),'RESOURCE_HISTORY_EFFECTIVE_LIMITS_CHANGED')
    paths=storage_paths(gate.broker.config,sid);storage=gate.native.storage(row,paths)
    R.need(storage==before['receipt']['nativeFacts']['storage'],'RESOURCE_HISTORY_STORAGE_CHANGED')
    from .worker_resource_native import _account_mounts
    accounts=_account_mounts(row)
    R.need(accounts==before['publication']['nativeBaseline']['accounts'],
           'RESOURCE_HISTORY_ACCOUNT_CHANGED')
    for account in accounts:
        R.need(R._identity(R.PROC/str(native['pid'])/'root'/account['destination'].lstrip('/'))==account['identity'],
               'RESOURCE_HISTORY_ACCOUNT_CHANGED')
    temporary=Path(paths.scratch)/'tmp'
    mounts=[mount for mount in row['Mounts'] if mount.get('Destination')=='/tmp']
    R.need(len(mounts)==1 and mounts[0].get('Type')=='bind' and mounts[0].get('Source')==str(temporary) and
           mounts[0].get('RW') is True and
           R._identity(temporary)==R._identity(R.PROC/str(native['pid'])/'root/tmp'),
           'RESOURCE_HISTORY_TEMP_CHANGED')
    gate.native.capacity(rows,gate.option)  # Fresh actual commitments; no old-source/delta credit.
    # LAST native producer. No capacity/kernel/store reader follows this bracket.
    R.need(gate._guard()==rows,'RESOURCE_HISTORY_NATIVE_CHANGED')
    _metadata(context,before)
    context.result={'state':'HISTORICAL_NATIVE_SETTLEMENT_CONFIRMED','operationId':op['id'],
        'reservationId':op['reservation_id'],'employeeId':eid,'targetSid':sid,
        'profileVersion':op['request']['profile_version'],'profileDigest':J.fingerprint(before['profile']),
        'previewDigest':op['request']['preview_digest'],
        'settlementDigest':J.fingerprint(before['receipt']),
        'currentBindingDigest':J.fingerprint({'employee':before['employee'],'native':native,'storage':storage}),
        'readOnly':True}


def inspect_completion(gate,authority,opid):
    J.canonical_uuid(opid)
    context=_Inspection(_MINT,gate,authority,opid)
    with gate.admission(deadline=time.monotonic()+30):
        gate._local.completion_inspection=context
    # Admission FD cleanup has finished. An observed finalizer-time change
    # refuses this read-only result; no hold/receipt/pending is ever modified.
    R.need(context.result is not None,'RESOURCE_HISTORY_INSPECTION_REQUIRED')
    for path,signature in context.stamps.items():
        R.need(_stamp(path)==signature,'RESOURCE_HISTORY_METADATA_CHANGED')
    for path,signature in context.parents.items():
        info=path.lstat()
        R.need((info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)==signature,
               'RESOURCE_HISTORY_ANCESTRY_CHANGED')
    authority.assert_live()
    return copy.deepcopy(context.result)
