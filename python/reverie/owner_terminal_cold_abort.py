"""Explicit owner closure of a never-started H candidate after availability restore.

No engine/service mutation, schema adoption, H phase result, or journal reset.
The separate approved acknowledgment preserves every original failed attempt.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

from . import owner_terminal_lifecycle as L

POINTER='owner-cold-abort.json'
ATTEMPT='OWNER-COLD-ABORT-ACK-ATTEMPT.private.json'
PURPOSE='owner-terminal-unpublished-cold-abort-v1'
EVIDENCE={'ATTEMPT.json','result.json','parent-receipt.private.json','old-before.private.json',
          'candidate-before.private.json','workers-before.private.json','workers-after.private.json'}


def need(value,reason):
    if not value:raise ValueError(reason)


def sha(raw):return 'sha256:'+hashlib.sha256(raw).hexdigest()


def read(path,limit=16<<20):return L._data_bytes(Path(path),limit,private=True)[0]


def bounded_names(path,maximum=64):
    fd=L.open_directory(path)
    try:
        names=[]
        with os.scandir(fd) as entries:
            for entry in entries:
                names.append(entry.name);need(len(names)<=maximum,'H_ABORT_DIRECTORY_BOUND')
        return sorted(names)
    finally:os.close(fd)


def never_started(row):
    state=row['State']
    return (state.get('Status')=='created' and state.get('Running') is False and state.get('Pid')==0
            and not state.get('Error') and state.get('OOMKilled') is False and not state.get('Paused')
            and not state.get('Restarting') and not state.get('Dead') and state.get('ExitCode',0)==0
            and state.get('StartedAt')=='0001-01-01T00:00:00Z'
            and state.get('FinishedAt')=='0001-01-01T00:00:00Z' and row.get('RestartCount',0)==0)


def unpublished(initial,candidate_id):
    """Positive no-publication prefix, not a claimed completion of H prepare."""
    control=initial.roots['controlBase'];ledger=initial.roots['ledgerBase']
    need(not os.path.lexists(control/L.CONTROL_CURRENT) and not os.path.lexists(control/L.CONTROL_PENDING),
         'H_ABORT_PUBLISHED_OR_PENDING_GENERATION')
    unit=initial.unit_state()
    need(unit['LoadState']=='not-found' and unit['MainPID']=='0' and unit['ActiveState']=='inactive'
         and not os.path.lexists(Path.home()/'.config/systemd/user'/L.UNIT),'H_ABORT_SERVICE_NOT_ABSENT')
    need(not bounded_names(initial.roots['bootstrapRoot']),'H_ABORT_BOOTSTRAP_NOT_EMPTY')
    names=set(bounded_names(control));names.discard(initial.path.name);names.discard(POINTER)
    need(1<=len(names)<=4 and all(re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',n) for n in names),
         'H_ABORT_UNKNOWN_UNPUBLISHED_NAMESPACE')
    result=[]
    for name in sorted(names):
        root=control/name;private=root/'installation.json';children=set(bounded_names(root,2))
        need(children in ({'installation.json'},{'installation.json','docker'}),'H_ABORT_UNKNOWN_GENERATION_FILES')
        value=json.loads(read(private));policy_sha=sha(read(private))
        need(value.get('controlRoot')==str(root) and value.get('ledgerRoot')==str(ledger/name)
             and value.get('bootstrapRoot')==str(initial.roots['bootstrapRoot'])
             and value.get('website',{}).get('containerId')==candidate_id
             and value['website'].get('initPid') is None and value['website'].get('initStart') is None,
             'H_ABORT_UNPUBLISHED_POLICY_CHANGED')
        args=value.get('hostProgram',{}).get('argv')
        need(type(args) is list and len(args)==6 and args[1:3]==['-I','-B']
             and args[-2:]==['--policy',str(private)] and type(args[3]) is str
             and args[3].startswith('/nix/store/') and args[3].endswith('/scripts/reverie-owner-terminal-host'),
             'H_ABORT_UNPUBLISHED_PROGRAM_CHANGED')
        entry=Path(args[3]);current=Path(initial.host_program['argvPrefix'][3])
        need(entry.stat().st_uid==0 and not entry.stat().st_mode&0o222
             and entry.read_bytes()==current.read_bytes(),'H_ABORT_UNKNOWN_HOST_ENTRY')
        need(not bounded_names(ledger/name),'H_ABORT_ISSUED_LEDGER_NOT_EMPTY')
        if 'docker' in children:
            info=(root/'docker').lstat()
            need(stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o700
                 and not bounded_names(root/'docker'),'H_ABORT_ENGINE_CONFIG_NOT_EMPTY')
        result.append({'generation':name,'policySHA256':policy_sha,'policyIdentity':list(L._native_stamp(private.lstat())),
                       'controlIdentity':list(L._directory_identity(root)),
                       'ledgerIdentity':list(L._directory_identity(ledger/name))})
    return result


def parent_files(folder,standard):
    """Hash bounded private history; never read terminal transcripts into output."""
    result={};count=0;deadline=time.monotonic()+120
    for directory,dirs,files in os.walk(folder,followlinks=False):
        depth=len(Path(directory).relative_to(folder).parts);need(depth<=1,'H_ABORT_HISTORY_DEPTH')
        need(len(dirs)+len(files)<=64,'H_ABORT_HISTORY_BOUND')
        for name in dirs:
            need(depth==0 and re.fullmatch('H-qualifier-[a-f0-9]{32}',name)
                 and not (Path(directory)/name).is_symlink(),'H_ABORT_UNKNOWN_HISTORY_DIRECTORY')
        for name in files:
            if name==ATTEMPT:continue
            need(not (name.startswith('H-') and any(x in name for x in ('start-listener','await-ready')))
                 and name!='H-prepare-created-RESULT.json','H_ABORT_NATIVE_PHASE_NOT_UNPUBLISHED')
            path=Path(directory)/name;info=path.lstat();count+=1
            need(count<=64 and stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid()
                 and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1,'H_ABORT_PRIVATE_HISTORY_REQUIRED')
            before=L._native_stamp(info)
            if name=='website-state.private.tar':digest,size=standard.file_hash(path,limit=8<<30,deadline=deadline)
            else:
                raw=read(path);digest=hashlib.sha256(raw).hexdigest();size=len(raw)
            need(L._native_stamp(path.lstat())==before,'H_ABORT_HISTORY_CHANGED')
            result[str(path.relative_to(folder))]={'sha256':digest,'bytes':size,'identity':list(before)}
    need('H-prepare-created-ATTEMPT.json' in result and 'checkpoint.private.json' in result
         and 'website-state.private.tar' in result,'H_ABORT_PREFIX_EVIDENCE_REQUIRED')
    checkpoint=json.loads(read(folder/'checkpoint.private.json'))
    need(result['website-state.private.tar']['sha256']==checkpoint['archiveSha256']
         and result['website-state.private.tar']['bytes']==checkpoint['archiveBytes'],'H_ABORT_CHECKPOINT_CHANGED')
    return result


def observe(initial,standard,native,evidence_path,baseline_path):
    evidence_path=L.physical(evidence_path);baseline_path=L.physical(baseline_path)
    need(set(bounded_names(evidence_path))==EVIDENCE,'H_ABORT_OPERATOR_EVIDENCE_SCHEMA')
    raw={name:read(evidence_path/name) for name in EVIDENCE};intent=json.loads(raw['ATTEMPT.json'])
    keys={'kind','reason','oldId','newId','oldImage','candidateNeverStarted','schemaState','parentReceiptSHA256',
          'heldCandidateName','automaticRollback','preserveAllFences','databaseRestore'}
    need(type(intent) is dict and set(intent)==keys and intent['kind']=='explicit-owner-prestart-cold-abort-v1'
         and intent['candidateNeverStarted'] is True and intent['schemaState']=='not-started'
         and intent['automaticRollback'] is False and intent['preserveAllFences'] is True
         and intent['databaseRestore'] is False,'H_ABORT_OWNER_INTENT_REQUIRED')
    report=json.loads(raw['result.json'])
    need(type(report) is dict and set(report)=={'state','websiteReady','workersPreserved','workers','siteImage','parentFencesPreserved','heldCandidate'}
         and report['state']=='OWNER_COLD_ABORT_RESTORED_ORIGINAL' and report['websiteReady'] is True
         and report['workersPreserved'] is True and report['parentFencesPreserved'] is True
         and report['siteImage']==intent['oldImage'] and report['heldCandidate']==intent['heldCandidateName'],
         'H_ABORT_OWNER_RESULT_REQUIRED')
    state=initial.roots['ledgerBase']/'website-updates';active=read(state/'website-active.json');record=json.loads(active)
    need(active==raw['parent-receipt.private.json'] and hashlib.sha256(active).hexdigest()==intent['parentReceiptSHA256']
         and record.get('state')=='unconfirmed' and record.get('oldStopped') is True
         and record.get('newStartAttempted') is False and record.get('schemaState')=='not-started'
         and record.get('oldId')==intent['oldId'] and record.get('newId')==intent['newId']
         and record.get('oldImage')==intent['oldImage'],'H_ABORT_PARENT_RECEIPT_CHANGED')
    need(re.fullmatch('[a-f0-9]{32}',record['operationId']) is not None,'H_ABORT_PARENT_OPERATION_REQUIRED')
    operation=state/('website-'+record['operationId']);plan_raw=read(operation/'plan.private.json');plan=standard.strict(plan_raw)
    need(read(operation/'receipt.private.json')==active and standard.digest(plan)==record['planDigest'],
         'H_ABORT_PARENT_PLAN_CHANGED')
    old=initial.engine.get('/containers/'+intent['oldId']+'/json')
    candidate=initial.engine.get('/containers/'+intent['newId']+'/json')
    prior_old=json.loads(raw['old-before.private.json']);prior_candidate=json.loads(raw['candidate-before.private.json'])
    need(old['Id']==prior_old['Id']==intent['oldId'] and old['Image']==prior_old['Image']==intent['oldImage']
         and old['Name']=='/'+native.name and old['State']['Running'] is True and old['State']['Pid']>1
         and old['Config']==prior_old['Config'] and standard.canonical_mount_records(old['Mounts'])==standard.canonical_mount_records(prior_old['Mounts']),
         'H_ABORT_RESTORED_SITE_CHANGED')
    host=lambda row:{k:v for k,v in row['HostConfig'].items() if k!='RestartPolicy'}
    need(host(old)==host(prior_old) and old['HostConfig']['RestartPolicy'] in
         ({'Name':'no','MaximumRetryCount':0},{'Name':'unless-stopped','MaximumRetryCount':0}),
         'H_ABORT_RESTORED_AUTHORITY_CHANGED')
    need(candidate['Id']==prior_candidate['Id']==intent['newId'] and candidate['Image']==plan['newImage']
         and candidate['Name']=='/'+intent['heldCandidateName'] and never_started(candidate)
         and never_started(prior_candidate) and candidate['Config']==prior_candidate['Config']
         and candidate['HostConfig']==prior_candidate['HostConfig']
         and standard.canonical_mount_records(candidate['Mounts'])==standard.canonical_mount_records(prior_candidate['Mounts'])
         and (candidate['Config'].get('Labels') or {}).get(standard.LABEL)==record['operationId'],
         'H_ABORT_CANDIDATE_STARTED_OR_CHANGED')
    from .owner_terminal_website import qualify_provider_baseline
    baseline=read(baseline_path)
    providers=json.loads(L._encoded(qualify_provider_baseline(initial,baseline,native.selection['providerPIDs'])))
    return {'parentOperationId':record['operationId'],'parentReceiptSHA256':sha(active),'parentPlanDigest':standard.digest(plan),
            'parentFiles':parent_files(operation,standard),'operatorEvidencePath':str(evidence_path),
            'operatorEvidenceSHA256':{name:sha(value) for name,value in raw.items()},
            'providerBaselinePath':str(baseline_path),'providerBaselineSHA256':sha(baseline),'providers':providers,
            'restoredId':old['Id'],'restoredImage':old['Image'],'restoredPin':standard.digest(standard.container_pin(old)),
            'candidateId':candidate['Id'],'candidateImage':candidate['Image'],
            'candidatePin':standard.digest(standard.container_pin(candidate)),
            'unpublished':unpublished(initial,candidate['Id'])}


def verify(initial,record=None,new_plan=None):
    """Read a completed owner closure; never manufacture a native phase result."""
    pointer=json.loads(read(initial.roots['controlBase']/POINTER,8192))
    need(type(pointer) is dict and set(pointer)=={'version','purpose','acknowledgment','sha256'}
         and type(pointer['version']) is int and pointer['version']==1 and pointer['purpose']==PURPOSE,
         'H_ABORT_ACK_POINTER_REQUIRED')
    path=Path(pointer['acknowledgment']);need(path.parent.parent==initial.roots['ledgerBase']/'website-cold-aborts'
         and path.name=='RESULT.json' and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',path.parent.name),
         'H_ABORT_ACK_LOCATION_CHANGED')
    raw=read(path);need(sha(raw)==pointer['sha256'],'H_ABORT_ACK_CHANGED');receipt=json.loads(raw)
    need(type(receipt) is dict and set(receipt)=={'version','purpose','state','planDigest','parentReceiptSHA256','parentPlanDigest',
         'parentOperationId','restoredId','restoredImage','candidateId','candidateImage','unpublished','initialSHA256'}
         and type(receipt['version']) is int and receipt['version']==1 and receipt['purpose']==PURPOSE and receipt['state']=='OWNER_ABORTED_NEVER_STARTED'
         and receipt['initialSHA256']==sha(read(initial.path)),'H_ABORT_ACK_SCHEMA')
    plan_raw=read(path.parent/'PLAN.json');plan=json.loads(plan_raw)
    need(sha(plan_raw)==receipt['planDigest'] and read(path.parent/'ATTEMPT.json')==L._encoded(
         {'version':1,'state':'OWNER_ACK_ATTEMPT_NO_REPLAY','planDigest':receipt['planDigest']}),'H_ABORT_ACK_ATTEMPT_CHANGED')
    need(type(plan) is dict and set(plan)=={'version','purpose','acknowledgment','initialSHA256','runtimeManifest',
         'facts','snapshot','controlBinding','controlGrantDigest','selectionSHA256','parentSelectionSHA256'}
         and type(plan['version']) is int and plan['version']==1 and plan['purpose']==PURPOSE
         and plan['acknowledgment']==path.parent.name and plan['initialSHA256']==receipt['initialSHA256'],
         'H_ABORT_PLAN_SCHEMA')
    facts=plan['facts'];operation=initial.roots['ledgerBase']/'website-updates'/('website-'+receipt['parentOperationId'])
    need(read(operation/ATTEMPT)==read(path.parent/'ATTEMPT.json')
         and all(facts[k]==receipt[k] for k in ('parentReceiptSHA256','parentPlanDigest','parentOperationId',
                    'restoredId','restoredImage','candidateId','candidateImage','unpublished')), 'H_ABORT_ACK_PARENT_CONTRADICTORY')
    # Parent plan uses the established canonical digest (without its newline).
    from .owner_terminal_website import _standard_stage
    standard=_standard_stage()
    need(sha(read(operation/'receipt.private.json'))==receipt['parentReceiptSHA256']
         and standard.digest(json.loads(read(operation/'plan.private.json')))==receipt['parentPlanDigest']
         and parent_files(operation,standard)==facts['parentFiles'],'H_ABORT_PARENT_CHANGED')
    need(unpublished(initial,receipt['candidateId'])==receipt['unpublished'],'H_ABORT_UNPUBLISHED_NAMESPACE_CHANGED')
    candidate=initial.engine.get('/containers/'+receipt['candidateId']+'/json')
    need(candidate['Image']==receipt['candidateImage'] and never_started(candidate)
         and standard.digest(standard.container_pin(candidate))==facts['candidatePin'], 'H_ABORT_CANDIDATE_STARTED_OR_CHANGED')
    if record is not None:
        need(sha(L._encoded(record))==receipt['parentReceiptSHA256'],'H_ABORT_ACTIVE_RECEIPT_CHANGED')
    if new_plan is not None:
        need(new_plan['oldId']==receipt['restoredId'] and new_plan['oldImage']==receipt['restoredImage'],
             'H_ABORT_FUTURE_SITE_CHANGED')
    return receipt


def prepare(initial,standard,native,stage,folder,evidence,baseline):
    need(not os.path.lexists(initial.roots['controlBase']/POINTER),'H_ABORT_ALREADY_ACKNOWLEDGED')
    facts=observe(initial,standard,native,evidence,baseline)
    operation=initial.roots['ledgerBase']/'website-updates'/('website-'+facts['parentOperationId'])
    need(not os.path.lexists(operation/ATTEMPT),'H_ABORT_ACK_ATTEMPT_ALREADY_CONSUMED')
    snapshot=native.snapshot();old=stage._container(native.name)
    control,grants=stage._admit_control(native.name,old,snapshot)
    plan={'version':1,'purpose':PURPOSE,'acknowledgment':folder.name,'initialSHA256':sha(read(initial.path)),
          'runtimeManifest':initial.runtime.pair,'facts':facts,'snapshot':snapshot,
          'controlBinding':control,'controlGrantDigest':grants,'selectionSHA256':sha(read(native.selection_path)),
          'parentSelectionSHA256':sha(read(folder/'ORIGINAL_SELECTION.json'))}
    need(observe(initial,standard,native,evidence,baseline)==facts,'H_ABORT_PREPARE_FACTS_CHANGED')
    L.exclusive(folder/'PLAN.json',L._encoded(plan))
    return {'state':'OWNER_COLD_ABORT_ACK_REVIEW_REQUIRED','acknowledgment':folder.name,
            'planDigest':sha(L._encoded(plan)),'restoredId':facts['restoredId'],'candidateId':facts['candidateId'],
            'parentReceiptSHA256':facts['parentReceiptSHA256'],'providerIncarnations':len(facts['providers']),
            'effects':False}


def apply(initial,standard,native,stage,folder,approved):
    raw=read(folder/'PLAN.json');need(sha(raw)==approved,'H_ABORT_REVIEWED_PLAN_CHANGED');plan=json.loads(raw)
    need(type(plan) is dict and set(plan)=={'version','purpose','acknowledgment','initialSHA256','runtimeManifest',
         'facts','snapshot','controlBinding','controlGrantDigest','selectionSHA256','parentSelectionSHA256'}
         and type(plan['version']) is int and plan['version']==1 and plan['purpose']==PURPOSE
         and plan['acknowledgment']==folder.name and plan['runtimeManifest']==initial.runtime.pair
         and plan['initialSHA256']==sha(read(initial.path))
         and plan['selectionSHA256']==sha(read(native.selection_path))
         and plan['parentSelectionSHA256']==sha(read(folder/'ORIGINAL_SELECTION.json'))
         and read(folder/'ORIGINAL_SELECTION.json')==read(initial.roots['ledgerBase']/'website-selection.json'),
         'H_ABORT_PLAN_SELECTION_CHANGED')
    facts=plan['facts'];operation=initial.roots['ledgerBase']/'website-updates'/('website-'+facts['parentOperationId'])
    def fresh():
        need(observe(initial,standard,native,facts['operatorEvidencePath'],facts['providerBaselinePath'])==facts,
             'H_ABORT_NATIVE_FACTS_CHANGED')
        snapshot=native.snapshot();control,grants=stage._admit_control(native.name,stage._container(native.name),snapshot)
        need(standard.digest(snapshot)==standard.digest(plan['snapshot']) and control==plan['controlBinding']
             and grants==plan['controlGrantDigest'],'H_ABORT_NATIVE_CAS_CHANGED')
    fresh()
    with stage.maintenance_lock():
        need(not os.path.lexists(initial.roots['controlBase']/POINTER) and not os.path.lexists(operation/ATTEMPT),
             'H_ABORT_ACK_ALREADY_CONSUMED')
        fresh()
        marker={'version':1,'state':'OWNER_ACK_ATTEMPT_NO_REPLAY','planDigest':approved}
        L.exclusive(operation/ATTEMPT,L._encoded(marker));L.exclusive(folder/'ATTEMPT.json',L._encoded(marker))
        # The new marker is distinct owner history. No parent phase/receipt is
        # overwritten, cleared or claimed to have completed.
        fresh()
        receipt={'version':1,'purpose':PURPOSE,'state':'OWNER_ABORTED_NEVER_STARTED','planDigest':approved,
                 'parentReceiptSHA256':facts['parentReceiptSHA256'],'parentPlanDigest':facts['parentPlanDigest'],
                 'parentOperationId':facts['parentOperationId'],'restoredId':facts['restoredId'],
                 'restoredImage':facts['restoredImage'],'candidateId':facts['candidateId'],
                 'candidateImage':facts['candidateImage'],'unpublished':facts['unpublished'],
                 'initialSHA256':plan['initialSHA256']}
        result=L._encoded(receipt);L.exclusive(folder/'RESULT.json',result)
        pointer={'version':1,'purpose':PURPOSE,'acknowledgment':str(folder/'RESULT.json'),'sha256':sha(result)}
        L.exclusive(initial.roots['controlBase']/POINTER,L._encoded(pointer))
        verify(initial)
    return receipt
