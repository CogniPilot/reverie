"""Owner-only staged resource policies without changing unrelated laptop grants."""
import hashlib
import json
import re

RESOURCE_FIELDS = frozenset({'budgetMode','memoryMiB','pidsLimit','cpus','poolMemoryMiB','poolTasksMax'})
SESSION = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')


def _validate_resource_fields(value):
    if not isinstance(value,dict) or set(value)!=RESOURCE_FIELDS:
        raise ValueError('A session resource policy must specify exactly six resource fields')
    for key,low,high in [('memoryMiB',0,1048576),('pidsLimit',64,4096),('poolMemoryMiB',512,1048576),('poolTasksMax',128,32768)]:
        if type(value[key]) is not int or not low<=value[key]<=high:
            raise ValueError('Invalid session resource limit: '+key)
    if (type(value['cpus']) not in (int,float) or not(value['cpus']==0 or .25<=value['cpus']<=64) or
        value['budgetMode'] not in ('pool','admission') or
        (value['budgetMode']=='admission' and value['memoryMiB']<512)):
        raise ValueError('Invalid session resource budget')


def validate_resources(value):
    _validate_resource_fields(value)
    if value['memoryMiB']>value['poolMemoryMiB']:
        raise ValueError('Invalid session resource budget')


def project_resource_policy(config,value):
    """Reservation domains use one global pool; legacy six-field policies remain readable."""
    _validate_resource_fields(value)
    result=dict(value)
    if 'resourceReservations' in config:
        for key in ('poolMemoryMiB','poolTasksMax'):
            result[key]=config[key]
    validate_resources(result)
    return result


def validate_session_resources(config):
    policies=config.get('sessionResources',{})
    if not isinstance(policies,dict) or len(policies)>32:
        raise ValueError('Invalid owner session resource map')
    for sid,policy in policies.items():
        if not isinstance(sid,str) or not SESSION.fullmatch(sid):
            raise ValueError('Invalid resource-policy session')
        project_resource_policy(config,policy)

    employees=config.get('employeeResources',{})
    if not isinstance(employees,dict) or len(employees)>256:
        raise ValueError('Invalid owner employee resource projection')
    for eid,policy in employees.items():
        if not isinstance(eid,str) or not SESSION.fullmatch(eid):
            raise ValueError('Invalid resource-policy employee')
        project_resource_policy(config,policy)


def employee_policy(config,sid):
    """Resolve a derived EID policy through the trusted storage binding only."""
    if __package__:
        from .worker_storage import storage_paths
    else:
        # The flat immutable broker/acceptance bundle has the same fixed sibling.
        import importlib.util
        import sys
        from pathlib import Path
        name=__name__+'_storage'
        if name not in sys.modules:
            spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name('worker_storage.py'))
            module=importlib.util.module_from_spec(spec);sys.modules[name]=module
            try:spec.loader.exec_module(module)
            except BaseException:sys.modules.pop(name,None);raise
        storage_paths=sys.modules[name].storage_paths
    paths=storage_paths(config,sid)
    return config['employeeResources'].get(paths.identity,{}) if paths.kind=='employee' else {}


def resource_config(config,sid):
    """Project resources only; lease-grant transformation remains separate."""
    validate_session_resources(config)
    # Native control custody is not a laptop grant and must not change any
    # existing laptop's create arguments or reattachment policy label.
    result={k:v for k,v in config.items() if k not in ('sessionResources','employeeResources','resourceReservations','browserJobPolicy','employeeGpuGrants')}
    employee_gpu=config.get('employeeGpuGrants',{})
    if type(employee_gpu)is not dict:raise ValueError('Invalid owner employee GPU grant map')
    if employee_gpu:
        if __package__:
            from .worker_gpu import projected_gpu_grants
        else:
            import importlib.util
            from pathlib import Path
            spec=importlib.util.spec_from_file_location(__name__+'_gpu',Path(__file__).with_name('worker_gpu.py'))
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            projected_gpu_grants=module.projected_gpu_grants
        gpu=projected_gpu_grants(config,sid)
        if gpu is not None:result['gpuGrants']=gpu
    policies=config.get('sessionResources',{})
    if sid in policies:
        result.update(project_resource_policy(config,policies[sid]))
    elif config.get('employeeResources'):
        policy=employee_policy(config,sid)
        if policy:result.update(project_resource_policy(config,policy))
    return result


def effective_config(config,sid):
    result=resource_config(config,sid)
    if result.get('leaseAcceptance') is not None:
        if __package__:
            from .cleanup import peer_port
        else:
            import importlib.util
            from pathlib import Path
            spec=importlib.util.spec_from_file_location('_resource_lease_peer',Path(__file__).with_name('cleanup')/'peer_port.py')
            peer_port=importlib.util.module_from_spec(spec);spec.loader.exec_module(peer_port)
        result=peer_port.worker_config(result,sid)
    return result


def policy_digest(config,sid):
    effective=effective_config(config,sid)
    return hashlib.sha256(json.dumps({k:v for k,v in effective.items() if k not in ('image','maintenanceSessions','opsConfig')},sort_keys=True).encode()).hexdigest()


def validate_resource_reload(before,after):
    validate_session_resources(after)
    ignored=RESOURCE_FIELDS|{'sessionResources','employeeResources'}
    if {k:v for k,v in before.items() if k not in ignored}!={k:v for k,v in after.items() if k not in ignored}:
        raise ValueError('Resource reload cannot change laptop grants, images or control paths')
