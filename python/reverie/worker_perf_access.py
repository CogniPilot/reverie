"""Owner-local task-perf intent, read-only preview and explicit cold domain CAS.

No stop/start, provider input, sysctl or capability effect. C authenticates the
actual host peer; queued intent never edits a running seat or grants launch.
"""
import copy
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

from . import laptop_resource_operations as J
from . import worker_perf as P
from . import worker_resource_reservations as R
from .worker_gpu_access import (_private, _stamp, _parents, _parents_current,
                                _current, _selected, _installed_consumers, _idle,
                                _requests as gpu_requests, NAME as GPU_REQUEST_NAME)
from .worker_resources import policy_digest
from .worker_storage import read_metadata

NAME = 'task-perf-owner-requests.json'
SCHEMA = 'reverie-owner-task-perf-requests-v1'
ACTIONS = frozenset(('perf-policy-status', 'perf-policy-request', 'perf-policy-preview', 'perf-policy-apply'))


def _replace(path, value, expected):
    path = Path(path); temporary = path.with_name(path.name+'.perf-'+str(uuid.uuid4()))
    R._write_exclusive(temporary, value)
    R.need((_stamp(path) if os.path.lexists(path) else None) == expected, 'PERF_FILE_CAS_CHANGED')
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try: os.fsync(fd)
    finally: os.close(fd)


def _stage(path,value):
    path=Path(path);temporary=path.with_name(path.name+'.perf-'+str(uuid.uuid4()))
    R._write_exclusive(temporary,value)
    observed,stamp=_private(temporary,os.getuid())
    R.need(observed==value,'PERF_STAGED_BYTES_CHANGED')
    return temporary,stamp


def _sync(directory):
    fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:os.fsync(fd)
    finally:os.close(fd)


def _kernel():
    def read(path, bound):
        with open(path, 'rb', buffering=0) as stream: raw = stream.read(bound+1)
        R.need(len(raw) <= bound, 'PERF_KERNEL_METADATA_BOUND')
        return raw.decode('ascii').strip()
    value = read('/proc/sys/kernel/perf_event_paranoid', 32)
    R.need(value in ('1', '2'), 'PERF_KERNEL_TASK_POLICY_UNAVAILABLE')
    boot = read('/proc/sys/kernel/random/boot_id', 64); J.canonical_uuid(boot)
    return {'bootId': boot, 'paranoid': int(value)}


def _requests(gate):
    path = gate.root/'operations'/NAME
    if not os.path.lexists(path): return {'schema': SCHEMA, 'requests': {}}, None
    value, stamp = _private(path, gate.broker.config['uid'])
    R.need(type(value) is dict and set(value) == {'schema','requests'} and value['schema'] == SCHEMA
           and type(value['requests']) is dict and len(value['requests']) <= 256, 'PERF_REQUEST_STORE')
    for eid, row in value['requests'].items():
        J.canonical_uuid(eid)
        R.need(type(row) is dict and set(row) == {'revision','sessionId','sessionGeneration','bindingDigest','policy'}, 'PERF_REQUEST_STORE')
        J.canonical_uuid(row['sessionId']); J.digest(row['bindingDigest'])
        R.need(type(row['revision']) is int and 1 <= row['revision'] <= 9007199254740991
               and type(row['sessionGeneration']) is int and 1 <= row['sessionGeneration'] <= 9007199254740991
               and (row['policy'] is None or type(row['policy']) is str and row['policy'] == P.POLICY), 'PERF_REQUEST_STORE')
    return value, stamp


def _gate(broker):
    R.need(broker.resource_reservations is not None and broker.config_file, 'PERF_OWNER_CONTROL_UNAVAILABLE')
    return broker.resource_reservations


def _names(directory):
    with os.scandir(directory) as entries:
        names=set()
        for item in entries:
            R.need(len(names)<1024 and item.is_file(follow_symlinks=False),'PERF_UNKNOWN_HISTORY')
            names.add(item.name)
    return names


def _history(gate):
    """Only known journals and complete prior perf attempts; never erase history."""
    directory=gate.root/'operations'; directory_stamp=_stamp(directory); names=_names(directory)
    fixed={'operations.json','operations.lock',NAME,GPU_REQUEST_NAME}
    pattern=re.compile(r'task-perf-attempt-([a-f0-9-]{36})-([1-9][0-9]{0,15})(-committed)?\.json')
    R.need(all(name in fixed or pattern.fullmatch(name) for name in names),'PERF_UNKNOWN_HISTORY')
    if GPU_REQUEST_NAME in names:gpu_requests(gate) # Validate, never spend GPU intent.
    total=0;deadline=gate.native._deadline()
    for name in names-fixed:
        match=pattern.fullmatch(name);J.canonical_uuid(match[1])
        attempt_name=name.replace('-committed.json','.json')
        complete_name=attempt_name[:-5]+'-committed.json'
        R.need(attempt_name in names and complete_name in names,'PERF_PRIOR_ATTEMPT_UNCONFIRMED')
        if match[3]:continue
        total+=(directory/attempt_name).lstat().st_size+(directory/complete_name).lstat().st_size
        R.need(total<=16<<20 and time.monotonic()<deadline,'PERF_HISTORY_BOUND')
        intent,_=_private(directory/attempt_name,gate.broker.config['uid'])
        complete,_=_private(directory/complete_name,gate.broker.config['uid'])
        R.need(type(intent)is dict and set(intent)=={'schema','plan','planDigest','beforeConfiguration',
               'afterConfiguration','beforeBinding','afterBinding'} and
               intent['schema']=='reverie-owner-task-perf-transition-v1' and
               J.fingerprint(intent['plan'])==intent['planDigest'] and
               type(complete)is dict and J.fingerprint(complete)==J.fingerprint({'schema':'reverie-owner-task-perf-commit-v1',
               'planDigest':intent['planDigest'],'attemptSHA256':J.fingerprint(intent),
               'afterConfigurationDigest':J.fingerprint(intent['afterConfiguration']),
               'pendingReleaseRequired':True}),'PERF_PRIOR_ATTEMPT_UNCONFIRMED')
    stamps={directory/name:_stamp(directory/name) for name in names}
    R.need(_stamp(directory)==directory_stamp,'PERF_HISTORY_CHANGED')
    stamps[directory]=directory_stamp
    return names,stamps


def _digest(config, current):
    return J.fingerprint({'current': current, 'domain': R.domain_digest(config),
                          'policy': policy_digest(config, current['sessionId'])})


def _current_config(gate, eid):
    config, stamp = _private(gate.broker.config_file, gate.broker.config['uid'])
    R.need(config == gate.broker.config, 'PERF_CONFIG_CHANGED')
    P.validate(config)
    return config, stamp, _current(config, eid)


def _stopped_current(gate, rows, stopped, *, deadline=None):
    if stopped is not None:
        selected = [row for row in rows if row.get('Id') == stopped['Id']]
        R.need(len(selected) == 1 and
               gate.native.stopped_state(selected[0], deadline=deadline) == stopped['State'], 'PERF_NATIVE_CHANGED')


def _native_current(gate,rows,stopped=None):
    # The ordinary gate covers its journal/marker. The additional fixed target
    # protects the actual broker configuration and every physical/nested alias.
    R.need(gate._guard()==rows and gate.native.custody(gate.root,Path(gate.broker.config_file))==rows
           and gate.native.inventory()==rows,'PERF_NATIVE_CHANGED')
    _stopped_current(gate, rows, stopped)


def status(broker, eid, *, deadline=None):
    deadline = time.monotonic()+30 if deadline is None else deadline
    gate = _gate(broker)
    with gate.admission(deadline=deadline):
        config, stamp, current = _current_config(gate, eid)
        requests, request_stamp = _requests(gate); queued = requests['requests'].get(eid)
        rows = gate._guard(); row = _selected(rows, config, current)
        applied = P.validate(config).get(eid)
        R.need(gate.native.inventory() == rows and _current(config,eid) == current
               and _private(broker.config_file,config['uid'])[1] == stamp
               and _requests(gate)[1] == request_stamp, 'PERF_STATUS_CHANGED')
        stale = queued is not None and (queued['sessionId'] != current['sessionId'] or
                 queued['sessionGeneration'] != current['sessionGeneration'])
        state = 'unchanged' if queued is None else 'stale' if stale else 'applied' if queued['policy'] == applied else 'pending'
        result = {'version':1,'purpose':'owner-task-perf-v1','employeeId':eid,
                  'current':{**current,'bindingDigest':_digest(config,current)},
                  'revision':queued['revision'] if queued else 0,'requested':queued,
                  'applied':{'policy':applied,'enabled':applied == P.POLICY},
                  # Configuration is no claim about the current kernel filter or perf success.
                  'active':{'known':row is None or row['State']['Running'] is False,
                            'running':row is not None and row['State']['Running'],
                            'enabled':False if row is None or row['State']['Running'] is False else None},
                  'state':state,'recreationRequired':row is not None and row['State']['Running'] and state=='pending'}
    return result


def request(broker, command):
    R.need(type(command) is dict and set(command) == {'action','employeeId','expected','enabled'}
           and command['action'] == 'perf-policy-request' and type(command['enabled']) is bool, 'PERF_REQUEST_SCHEMA')
    expected = command['expected']
    R.need(type(expected) is dict and set(expected) == {'sessionId','sessionGeneration','bindingDigest','revision'}, 'PERF_REQUEST_CAS_SCHEMA')
    J.canonical_uuid(expected['sessionId']); J.digest(expected['bindingDigest'])
    R.need(type(expected['sessionGeneration']) is int and expected['sessionGeneration'] >= 1
           and type(expected['revision']) is int and 0 <= expected['revision'] < 9007199254740991, 'PERF_REQUEST_CAS_SCHEMA')
    gate = _gate(broker); eid = command['employeeId']; deadline = time.monotonic()+30
    with gate.admission(deadline=deadline):
        config, stamp, current = _current_config(gate,eid); document, request_stamp = _requests(gate)
        company, company_stamp = _private(config['companyFile'], config['uid'])
        old = document['requests'].get(eid)
        R.need(expected == {'sessionId':current['sessionId'],'sessionGeneration':current['sessionGeneration'],
               'bindingDigest':_digest(config,current),'revision':old['revision'] if old else 0}, 'PERF_STALE_REQUEST')
        if command['enabled']:
            P.artifact(); _kernel()
            R.need(config.get('rootlessDocker',{}).get('enabled') is True,'PERF_ROOTLESS_POLICY_REQUIRED')
        document['requests'][eid] = {'revision':expected['revision']+1,'sessionId':current['sessionId'],
                'sessionGeneration':current['sessionGeneration'],'bindingDigest':expected['bindingDigest'],
                'policy':P.POLICY if command['enabled'] else None}
        R.need(len(document['requests']) <= 256, 'PERF_REQUEST_STORE_FULL')
        gate._guard(); R.need(gate.native.inventory() == gate._guard(), 'PERF_NATIVE_CHANGED')
        R.need(_current(config,eid) == current and _private(config['companyFile'],config['uid'])[0] == company, 'PERF_CURRENT_CHANGED')
        R.need(_stamp(broker.config_file) == stamp and _stamp(config['companyFile']) == company_stamp
               and (_stamp(gate.root/'operations'/NAME) if request_stamp else None) == request_stamp
               and time.monotonic() < deadline, 'PERF_REQUEST_CAS_CHANGED')
        _replace(gate.root/'operations'/NAME,document,request_stamp)
    return status(broker,eid,deadline=deadline)


def _plan(gate, eid):
    broker = gate.broker; before, config_stamp, current = _current_config(gate,eid)
    company, company_stamp = _private(before['companyFile'],before['uid'])
    requests, request_stamp = _requests(gate); queued = requests['requests'].get(eid)
    R.need(queued is not None and queued['sessionId'] == current['sessionId']
           and queued['sessionGeneration'] == current['sessionGeneration']
           and queued['bindingDigest'] == _digest(before,current), 'PERF_STALE_REQUEST')
    rows = gate._guard(); _native_current(gate,rows); selected = _selected(rows,before,current)
    R.need(not any(row.get('State',{}).get('Running') is True and
                  row.get('Config',{}).get('Labels',{}).get('reverie.employee') == eid for row in rows), 'PERF_SELECTED_MUST_BE_STOPPED')
    stopped = None
    if selected is not None:
        state = gate.native.stopped_state(selected)
        R.need(state['Running'] is False and state.get('Pid') == 0 and
               state.get('Status') in ('exited','created') and type(state.get('StartedAt'))is str
               and 1<=len(state['StartedAt'])<=80 and type(selected.get('Id'))is str
               and re.fullmatch('[a-f0-9]{64}',selected['Id']) and selected.get('Image')==before['image']
               and all(state.get(k) is False for k in ('Paused','Restarting','Dead')), 'PERF_STOPPED_NATIVE_UNKNOWN')
        stopped = {'Id': selected['Id'], 'State': state}
    R.need(not _installed_consumers(before), 'PERF_INSTALLED_CONSUMERS_REQUIRE_RECONCILIATION')
    _idle(gate); gate.check_headroom()
    fixed = P.artifact(); kernel = _kernel()
    after = copy.deepcopy(before)
    policies = after.setdefault('employeePerfPolicies',{})
    if queued['policy'] is None: policies.pop(eid,None)
    else: policies[eid] = P.POLICY
    R.need(P.validate(before).get(eid) != queued['policy'], 'PERF_ALREADY_APPLIED')
    from .worker import validate_config
    validate_config(after)
    for employee in company['employees']:
        sid = employee.get('sessionId')
        if sid and sid != current['sessionId']:
            R.need(policy_digest(before,sid) == policy_digest(after,sid),'PERF_PEER_POLICY_CHANGED')
    R.need({k:v for k,v in before.items() if k!='employeePerfPolicies'} ==
           {k:v for k,v in after.items() if k!='employeePerfPolicies'}, 'PERF_UNRELATED_CONFIG_CHANGED')
    old_binding, binding_stamp = _private(R.marker(before),before['uid'])
    R.need(old_binding == gate.binding,'PERF_CONTROL_BINDING_CHANGED')
    new_binding = copy.deepcopy(old_binding); new_binding['configurationDigest'] = R.domain_digest(after)
    history_names,history_stamps=_history(gate)
    protected = [gate.root/'profiles/profiles.json']
    stamps = {Path(broker.config_file):config_stamp, R.marker(before):binding_stamp,
              Path(before['companyFile']):company_stamp, gate.root/'operations'/NAME:request_stamp,
              **history_stamps, **{p:_stamp(p) if os.path.lexists(p) else None for p in protected}}
    parents = _parents(stamps)
    plan = {'version':1,'purpose':'owner-task-perf-cold-plan-v1','employeeId':eid,'current':current,
            'request':queued,'beforeDigest':J.fingerprint(before),'afterDigest':J.fingerprint(after),
            'beforeBindingDigest':J.fingerprint(old_binding),'afterBindingDigest':J.fingerprint(new_binding),
            'nativeDigest':J.fingerprint(rows),'stoppedNative':stopped,'companyDigest':J.fingerprint(company),
            'artifact':fixed,'kernel':kernel,'historyNames':sorted(history_names),'stamps':{str(p):list(s) if s is not None else None for p,s in stamps.items()},
            'parents':{str(p):list(s) for p,s in parents.items()}}
    _native_current(gate,rows,stopped)
    R.need(_private(before['companyFile'],before['uid'])[0] == company and _current(before,eid) == current,'PERF_CURRENT_CHANGED')
    _parents_current(parents); _leaves(stamps)
    return plan, before, after, old_binding, new_binding, rows, stamps, parents


def _leaves(stamps):
    R.need(all((_stamp(p) if os.path.lexists(p) else None) == stamp for p,stamp in stamps.items()),'PERF_TERMINAL_METADATA_CHANGED')


def preview(broker,eid):
    gate = _gate(broker); deadline=time.monotonic()+30
    with gate.admission(deadline=deadline):
        plan,*rest = _plan(gate,eid); stamps,parents=rest[-2:]
    _parents_current(parents); _leaves(stamps)
    R.need(time.monotonic()<deadline,'PERF_PREVIEW_DEADLINE')
    return {'version':1,'purpose':'owner-task-perf-v1','state':'READY_COLD','effects':0,
            'plan':plan,'planDigest':J.fingerprint(plan)}


class _Transition:
    pass


def owns_pending(gate):
    record=getattr(gate._local,'perf_transition',None)
    return (type(record) is _Transition and record.gate is gate and
            (os.fstat(gate._local.fd).st_dev,os.fstat(gate._local.fd).st_ino) == record.lock
            and _private(R.pending(gate.broker.config),gate.broker.config['uid']) == record.pending)


def check_transition_rows(gate,rows):
    record=getattr(gate._local,'perf_transition',None)
    R.need(type(record) is _Transition and record.gate is gate and rows == record.rows,'PERF_NATIVE_CHANGED')
    _stopped_current(gate, rows, record.stopped)


def apply(broker,eid,expected_plan):
    J.digest(expected_plan); gate=_gate(broker); deadline=time.monotonic()+30; record=None
    try:
        with gate.admission(deadline=deadline):
            plan,before,after,old_binding,new_binding,rows,stamps,parents=_plan(gate,eid)
            R.need(J.fingerprint(plan) == expected_plan,'PERF_PREVIEW_CHANGED')
            attempt=gate.root/'operations'/('task-perf-attempt-'+eid+'-'+str(plan['request']['revision'])+'.json')
            complete=attempt.with_name(attempt.stem+'-committed.json')
            R.need(not os.path.lexists(attempt) and not os.path.lexists(complete),'PERF_ATTEMPT_ALREADY_CONSUMED')
            intent={'schema':'reverie-owner-task-perf-transition-v1','plan':plan,'planDigest':expected_plan,
                    'beforeConfiguration':before,'afterConfiguration':after,
                    'beforeBinding':old_binding,'afterBinding':new_binding}
            R._write_exclusive(R.pending(before),intent)
            record=_Transition();record.gate=gate;record.rows=copy.deepcopy(rows);record.stopped=plan['stoppedNative']
            info=os.fstat(gate._local.fd);record.lock=(info.st_dev,info.st_ino)
            record.pending=_private(R.pending(before),before['uid']);gate._local.perf_transition=record
            R._write_exclusive(attempt,intent)
            operations=gate.root/'operations'; operations_stamp=_stamp(operations)
            R.need(_names(operations)==set(plan['historyNames'])|{attempt.name},'PERF_HISTORY_CHANGED')
            actual,attempt_stamp=_private(attempt,before['uid'])
            R.need(actual==intent,'PERF_ATTEMPT_CHANGED')
            config_temp,config_temp_stamp=_stage(broker.config_file,after)
            marker_temp,marker_temp_stamp=_stage(R.marker(before),new_binding)
            pre_cas={**stamps,operations:operations_stamp,attempt:attempt_stamp,
                     config_temp:config_temp_stamp,marker_temp:marker_temp_stamp}
            # Fsync/finalizers above precede the final pre-CAS actual producers,
            # then all named static leaves. Never overwrite a changed selection.
            _native_current(gate,rows,plan['stoppedNative'])
            R.need(_current(before,eid) == plan['current'] and _kernel() == plan['kernel'],'PERF_CURRENT_CHANGED')
            _parents_current(parents);_leaves(pre_cas)
            os.replace(config_temp,broker.config_file);_sync(Path(broker.config_file).parent)
            config_value,config_stamp=_private(broker.config_file,before['uid'])
            R.need(config_value==after,'PERF_CONFIG_READBACK_CHANGED')
            del pre_cas[config_temp];pre_cas[Path(broker.config_file)]=config_stamp
            # The first rename's fsync and readback finalizers precede another
            # real producer/static bracket before the marker CAS.
            _native_current(gate,rows,plan['stoppedNative'])
            R.need(_current(before,eid)==plan['current'] and _kernel()==plan['kernel'],'PERF_CURRENT_CHANGED')
            _parents_current(parents);_leaves(pre_cas)
            os.replace(marker_temp,R.marker(before));_sync(R.marker(before).parent)
            broker.config=after;gate.binding=new_binding
            _native_current(gate,rows,plan['stoppedNative'])
            committed={'schema':'reverie-owner-task-perf-commit-v1','planDigest':expected_plan,
                 'attemptSHA256':J.fingerprint(intent),'afterConfigurationDigest':J.fingerprint(after),
                 'pendingReleaseRequired':True}
            R._write_exclusive(complete,committed)
            operations=gate.root/'operations'; operations_stamp=_stamp(operations)
            R.need(_names(operations)==set(plan['historyNames'])|{attempt.name,complete.name},'PERF_HISTORY_CHANGED')
            terminal={**stamps,operations:operations_stamp,R.pending(after):record.pending[1]}
            for path,expected in ((Path(broker.config_file),after),(R.marker(after),new_binding),
                                  (attempt,intent),(complete,committed)):
                value,stamp=_private(path,before['uid'])
                R.need(value==expected,'PERF_COMMIT_READBACK_CHANGED');terminal[path]=stamp
            _native_current(gate,rows,plan['stoppedNative'])
            _parents_current(parents);_leaves(terminal)
        # Admission and its descriptor finalizers have finished.
        R.need(_current(after,eid) == plan['current'] and _kernel() == plan['kernel'],'PERF_CURRENT_CHANGED')
        # Those final file/kernel readers may block. Observe complete current
        # native facts/custody afterward, still under the original finite budget
        # and durable pending fence; no second admission or operation is opened.
        R.need(gate.native.custody(gate.root,Path(broker.config_file),deadline=deadline)==rows and
               gate.native.custody(gate.root,R.marker(after),deadline=deadline)==rows and
               gate.native.inventory(deadline)==rows,'PERF_NATIVE_CHANGED')
        _stopped_current(gate, rows, plan['stoppedNative'], deadline=deadline)
        _parents_current(parents);_leaves(terminal)
        R.need(_stamp(R.pending(after)) == record.pending[1],'PERF_PENDING_REPLACED')
        R.need(time.monotonic()<deadline,'PERF_APPLY_DEADLINE')
        os.unlink(R.pending(after))
    except BaseException:
        if record is not None:raise RuntimeError('PERF_APPLY_REQUIRES_RECONCILIATION') from None
        raise
    finally:
        gate._local.perf_transition=None
    return {'version':1,'purpose':'owner-task-perf-v1','state':'CONFIGURED_COLD_RECREATE_REQUIRED',
            'planDigest':expected_plan,'employeeId':eid,'policy':plan['request']['policy'],
            'nativeStarted':False,'perfTested':False}


def decode(raw):
    def unique(items):
        value={}
        for key,item in items:R.need(key not in value,'PERF_DUPLICATE_KEY');value[key]=item
        return value
    return json.loads(raw,object_pairs_hook=unique,
            parse_constant=lambda _:(_ for _ in ()).throw(ValueError('PERF_NONFINITE')))


def dispatch(broker,command):
    R.need(type(command) is dict and command.get('action') in ACTIONS,'PERF_CONTROL_SCHEMA')
    action=command['action']
    if action=='perf-policy-request':return request(broker,command)
    R.need(set(command)==({'action','employeeId','planDigest'} if action=='perf-policy-apply' else {'action','employeeId'}),'PERF_CONTROL_SCHEMA')
    if action=='perf-policy-status':return status(broker,command['employeeId'])
    if action=='perf-policy-preview':return preview(broker,command['employeeId'])
    return apply(broker,command['employeeId'],command['planDigest'])
