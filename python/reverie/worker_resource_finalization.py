"""Protected native completion and conservative pending-fence settlement.

Only the actual executing owner/claim/readiness producer reaches complete().
VERIFY_RECORDED, JSON, a digest, a cold lookup or a prior process-local handle
never does. Completion history is validated before excluding a positive hold;
every new admission still observes actual current native commitments.
"""
import copy
import os
import stat
import time
from pathlib import Path

from . import laptop_resource_operations as J
from . import worker_resource_reservations as R
from . import worker_resource_native as N

_MINT=object()
SCHEMA='reverie-resource-native-completion-v1'


def _metadata(gate):
    R.need(R.option(gate.broker.config)==gate.option and
           R.domain_digest(gate.broker.config)==gate.binding['configurationDigest'] and
           R._file(R.marker(gate.broker.config),gate.broker.config['uid'])==gate.binding,
           'RESOURCE_COMPLETION_CONTROL_CHANGED')
    R.need(not os.path.lexists(R.pending(gate.broker.config)), 'RESOURCE_COMPLETION_CONTROL_CHANGED')
    fd,identity=R._directory(Path(gate.broker.config['stateRoot']),gate.broker.config['uid'])
    try:R.need(identity==gate.binding['stateDirectory'],'RESOURCE_COMPLETION_CONTROL_CHANGED')
    finally:os.close(fd)
    for name,expected in gate.binding['directories'].items():
        fd,identity=R._directory(gate.root if name=='.' else gate.root/name,gate.broker.config['uid'])
        try:R.need(identity==expected,'RESOURCE_COMPLETION_CONTROL_CHANGED')
        finally:os.close(fd)
    for name,expected in gate.binding['locks'].items():
        info=(gate.root/name/(name+'.lock')).lstat()
        R.need(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode)==0o600 and
               info.st_uid==gate.broker.config['uid'] and info.st_nlink==1 and
               [info.st_dev,info.st_ino]==expected,'RESOURCE_COMPLETION_CONTROL_CHANGED')
    info=(gate.root/'admission.lock').lstat()
    R.need(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode)==0o600 and
           info.st_uid==gate.broker.config['uid'] and info.st_nlink==1 and
           [info.st_dev,info.st_ino]==gate.binding['admissionLock'],'RESOURCE_COMPLETION_CONTROL_CHANGED')


def _paths(gate,opid):
    J.canonical_uuid(opid)
    return (gate.root/'operations'/('settled-'+opid+'.json'),
            gate.root/'operations'/('settlement-'+opid+'.pending.json'))


def require_consistent_pending(gate,document):
    """The existing pending fence cannot disappear behind a lost journal row."""
    for count,path in enumerate((gate.root/'operations').iterdir(),1):
        R.need(count<=4096,'RESOURCE_COMPLETION_PENDING_BOUND')
        if not(path.name.startswith('settlement-') and path.name.endswith('.pending.json')):continue
        opid=path.name[len('settlement-'):-len('.pending.json')];J.canonical_uuid(opid)
        value=R._file(path,gate.broker.config['uid'])
        J.exact(value,('schema','operationId','reservationId','verifiedReceiptDigest'))
        op=document['operations'].get(opid)
        R.need(value['schema']=='reverie-resource-settlement-pending-v1' and value['operationId']==opid and
               op is not None and op['state'] in ('VERIFY_RECORDED','COMPLETED') and
               value['reservationId']==op['reservation_id'],'RESOURCE_COMPLETION_ORPHAN_PENDING')
        J.digest(value['verifiedReceiptDigest'])


def _terminal_metadata(owner,claim,receipt,document):
    """All producers/FD finalizers precede the last metadata stamp bracket.

    No engine/kernel reread or handle resurrection is performed here. Observed
    close-time changes remain uncertain. External writes after these final
    observations are not made atomic by the cooperating admission protocol.
    """
    from .worker_resource_preparation import _policy_current
    from .employee_resource_profiles import document as profiles_document
    from .worker_storage import read_metadata
    gate=owner.gate;op=claim['lease'].view['operation'];uid=gate.broker.config['uid']
    receipt_path,pending=_paths(gate,op['id'])
    paths=[Path(claim['policy_path']),Path(gate.broker.config['companyFile']),
        gate.root/'profiles/profiles.json',gate.root/'operations/operations.json',receipt_path,pending,
        gate.root/'operations'/('publication-'+op['id']+'.json'),
        gate.root/'operations'/('prepared-'+op['id']+'.json'),
        gate.root/'operations'/('verified-'+op['id']+'.json'),R.marker(gate.broker.config),
        gate.root/'admission.lock',gate.root/'profiles/profiles.lock',gate.root/'operations/operations.lock']
    if claim.get('plan_context') is not None:
        paths.append(Path(gate.broker.config['companyFile']).with_name('plan-moves.json'))
    def stamp(path):
        info=path.lstat()
        R.need(stat.S_ISREG(info.st_mode) and info.st_uid==uid and info.st_nlink==1 and
               not info.st_mode&0o022,'RESOURCE_COMPLETION_METADATA_CHANGED')
        return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,
                info.st_size,info.st_mtime_ns,info.st_ctime_ns)
    before={path:stamp(path) for path in paths}
    # A directory rename followed by a parent symlink can leave every leaf
    # inode unchanged. Retain the actual ancestry too, without opening a new
    # descriptor after the final metadata reads.
    parents={parent for path in paths for parent in path.parents}
    R.need(len(parents)<=1024,'RESOURCE_COMPLETION_METADATA_BOUND')
    def directory_stamp(path):
        info=path.lstat();sticky=info.st_uid==0 and bool(info.st_mode&stat.S_ISVTX)
        R.need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0,uid) and
               (not info.st_mode&0o022 or sticky),'RESOURCE_COMPLETION_ANCESTRY_CHANGED')
        return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)
    ancestry={path:directory_stamp(path) for path in parents}
    _policy_current(gate,claim);_metadata(gate)
    current=R._file(gate.root/'operations/operations.json',uid);J.document(current)
    R.need(current==document,'RESOURCE_COMPLETION_OPERATION_CHANGED')
    profiles=R._file(gate.root/'profiles/profiles.json',uid);profiles_document(profiles)
    R.need(profiles['profiles'].get(op['request']['employee_id'])==claim['lease'].context['profile'],
           'RESOURCE_COMPLETION_PROFILE_CHANGED')
    N.assert_employee_current(claim,read_metadata(gate.broker.config['companyFile'],uid))
    R.need(R._file(receipt_path,uid)==receipt and completed(gate,op) is False,
           'RESOURCE_COMPLETION_RECEIPT_CHANGED')
    require_consistent_pending(gate,current)
    # All reads and their descriptor finalizers above have finished. These
    # final observations open no new descriptor and cannot replace a lock.
    for path,signature in before.items():
        R.need(stamp(path)==signature,'RESOURCE_COMPLETION_METADATA_CHANGED')
    for path,signature in ancestry.items():
        R.need(directory_stamp(path)==signature,'RESOURCE_COMPLETION_ANCESTRY_CHANGED')
    authority=claim.get('owner_authority')
    if authority is not None:authority.assert_live()


def completed(gate,op):
    """Historical business proof only. A pending marker still retains/fences.
    This never observes an old PID as current or creates a launch permit.
    """
    if op['state']!='COMPLETED':return False
    receipt_path,pending=_paths(gate,op['id'])
    receipt=R._file(receipt_path,gate.broker.config['uid'])
    J.exact(receipt,('schema','operationId','reservationId','beforeOperationDigest','verifiedReceiptDigest',
        'profile','nativeFacts','normalSession','planRecord','state'))
    R.need(receipt['schema']==SCHEMA and receipt['state']=='COMPLETED_NATIVE_SETTLED' and
           receipt['operationId']==op['id'] and receipt['reservationId']==op['reservation_id'] and
           J.fingerprint(receipt)==op['last_receipt_digest'],'RESOURCE_COMPLETION_RECEIPT_CHANGED')
    before=copy.deepcopy(op);before.update(state='VERIFY_RECORDED',version=7,
                                          last_receipt_digest=receipt['verifiedReceiptDigest'])
    R.need(J.fingerprint(before)==receipt['beforeOperationDigest'],'RESOURCE_COMPLETION_OPERATION_CHANGED')
    from .employee_resource_profiles import profile as validate_profile
    profile=receipt['profile'];validate_profile(profile,op['request']['employee_id'])
    R.need(str(profile['version'])==op['request']['profile_version'] and
           profile['binding']['current_sid']==op['observation']['current_sid'] and
           profile['binding']['target_sid']==op['reserved_sid'] and
           profile['resources']['memoryMiB']*J.MIB==J.memory(op['request']['requested_memory_bytes']),
           'RESOURCE_COMPLETION_PROFILE_CHANGED')
    verified=R._file(gate.root/'operations'/('verified-'+op['id']+'.json'),gate.broker.config['uid'])
    R.need(J.fingerprint(verified)==receipt['verifiedReceiptDigest'] and
           verified['nativeFacts']==receipt['nativeFacts'] and
           verified['operationId']==op['id'] and verified['reservationId']==op['reservation_id'],
           'RESOURCE_COMPLETION_VERIFICATION_CHANGED')
    record=receipt['planRecord'];intent=record.get('resourceIntent') if type(record) is dict else None
    R.need(type(intent) is dict and record.get('id')==op['id'] and record.get('employeeId')==op['request']['employee_id'] and
           record.get('oldSession')==op['observation']['current_sid'] and record.get('newSession')==op['reserved_sid'] and
           record.get('phase')=='completed' and record.get('resourcePhase')=='verified' and
           record.get('sourceStopRequested') is True and record.get('sourceCleanupVerified') is True and
           intent.get('operationId')==op['id'] and intent.get('reservationId')==op['reservation_id'] and
           intent.get('profileDigest')==J.fingerprint(profile) and
           receipt['normalSession'].get('recordDigest')==J.fingerprint(record),
           'RESOURCE_COMPLETION_PLAN_CHANGED')
    return not os.path.lexists(pending)


class _Settlement:
    def __init__(self,token,owner,key,readiness,receipt,document,facts):
        R.need(token is _MINT,'RESOURCE_COMPLETION_PRODUCER_REQUIRED')
        self.owner,self.key,self.readiness=owner,key,readiness
        self.receipt,self.document,self.facts=copy.deepcopy(receipt),copy.deepcopy(document),copy.deepcopy(facts)
        self.operation=copy.deepcopy(owner._current(key)['lease'].view['operation'])


def assert_completion(proof,store,scope,operation):
    R.need(type(proof) is _Settlement and proof.owner.gate.scope==scope,'RESOURCE_COMPLETION_PRODUCER_REQUIRED')
    claim=proof.owner._current(proof.key);lease=claim['lease'];gate=proof.owner.gate
    R.need(claim.get('settlement') is proof and lease.store is store and operation==proof.operation and
           getattr(gate._local,'settlement',None) is proof,'RESOURCE_COMPLETION_PRODUCER_REQUIRED')
    receipt_path,pending=_paths(gate,operation['id'])
    R.need(os.path.lexists(pending) and R._file(receipt_path,gate.broker.config['uid'])==proof.receipt,
           'RESOURCE_COMPLETION_PENDING_REQUIRED')
    proof.readiness.assert_current()
    # The accepted store owns the actual journal flock here; fixed native ACK
    # context avoids reopening it and still rechecks all real kernel facts.
    permit=claim['runtime_permit']
    fence=N._RuntimeJournalFence(proof.owner,proof.key,permit,proof.document,proof.facts,proof.readiness)
    previous=getattr(gate._local,'runtime_ack',None)
    claim['runtime_journal_fence']=fence;gate._local.runtime_ack=fence
    try:R.need(N.observe_created(gate,permit,_locked=fence)==proof.facts,'RESOURCE_COMPLETION_NATIVE_CHANGED')
    finally:
        gate._local.runtime_ack=previous;claim.pop('runtime_journal_fence',None)
    return J.fingerprint(proof.receipt)


def complete(owner,key,readiness):
    from .worker_resource_actor import _ReadinessProof
    from .worker_resource_preparation import _document,_owner_live,_policy_current
    claim=owner._current(key);lease=claim['lease'];gate=owner.gate
    R.need(type(readiness) is _ReadinessProof and readiness.connection.owner is owner and
           readiness.selected['key'] is key and readiness.stage=='finalize' and
           claim.get('final_readiness') is readiness and not claim.get('completion_attempted'),
           'RESOURCE_COMPLETION_PRODUCER_REQUIRED')
    claim['completion_attempted']=True
    deadline=time.monotonic()+30
    try:
        with gate.admission(deadline=deadline):
            op=lease.view['operation'];R.need(op['state']=='VERIFY_RECORDED' and op['version']==7,
                                             'RESOURCE_COMPLETION_VERIFICATION_REQUIRED')
            receipt_path,pending=_paths(gate,op['id'])
            R._write_exclusive(pending,{'schema':'reverie-resource-settlement-pending-v1','operationId':op['id'],
                'reservationId':op['reservation_id'],'verifiedReceiptDigest':op['last_receipt_digest']})
            pending_stat=pending.lstat()
            stamp=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_size,
                                value.st_mtime_ns,value.st_ctime_ns)
            readiness.assert_current()
            facts=N.observe_created(gate,claim['runtime_permit'])
            R.need(facts==claim['verified_receipt']['nativeFacts'],'RESOURCE_COMPLETION_NATIVE_CHANGED')
            document,_signature=_document(gate)
            receipt={'schema':SCHEMA,'operationId':op['id'],'reservationId':op['reservation_id'],
                'beforeOperationDigest':J.fingerprint(op),'verifiedReceiptDigest':op['last_receipt_digest'],
                'profile':copy.deepcopy(lease.context['profile']),'nativeFacts':facts,
                'normalSession':copy.deepcopy(readiness.proof),'planRecord':copy.deepcopy(readiness.record),
                'state':'COMPLETED_NATIVE_SETTLED'}
            R._write_exclusive(receipt_path,receipt)
            proof=_Settlement(_MINT,owner,key,readiness,receipt,document,facts)
            claim['settlement']=proof;gate._local.settlement=proof
            try:lease.view=lease.store.complete_native(gate.scope,lease.handle,proof,expected_version=7)
            finally:gate._local.settlement=None
            op=lease.view['operation'];claim['runtime_permit']=N._RuntimePermit(owner,key,op['id'],
                op['reservation_id'],op['reserved_sid'],op['version'])
            completed_document=copy.deepcopy(document);completed_document['revision']+=1
            completed_document['operations'][op['id']]=copy.deepcopy(op)
            gate._local.start_boundary=N._StartBoundary(claim['runtime_permit'])
            # Pending remains visible through the outer admission's real native
            # terminal guard, unlock and descriptor finalizers.
        lease.close()
        # Only anchored metadata remains after all producer/store/lock close
        # work. A power-loss-resurrected marker refuses future admission.
        _terminal_metadata(owner,claim,receipt,completed_document)
        R.need(stamp(pending.lstat())==stamp(pending_stat),'RESOURCE_COMPLETION_PENDING_CHANGED')
        for path,expected in [(gate.root,gate.binding['directories']['.']),
                              (gate.root/'operations',gate.binding['directories']['operations'])]:
            info=path.lstat()
            R.need(stat.S_ISDIR(info.st_mode) and [info.st_dev,info.st_ino]==expected,
                   'RESOURCE_COMPLETION_CONTROL_CHANGED')
        R.need(time.monotonic()<deadline,'RESOURCE_COMPLETION_DEADLINE')
        os.unlink(pending)  # LAST fallible business operation; no later fsync/close.
        return {'state':'COMPLETED_NATIVE_SETTLED','operationId':op['id'],
                'capacityRetained':False,'retryAllowed':False}
    except BaseException as error:
        try:lease.close()
        except BaseException:error.add_note('RESOURCE_COMPLETION_CLOSE_UNCONFIRMED')
        raise J.OperationCommitUncertain('RESOURCE_COMPLETION_UNCERTAIN_KEEP_PENDING') from error
