"""Owner-only staged resource policies without changing unrelated laptop grants."""
import hashlib
import json
import re

RESOURCE_FIELDS = frozenset({'budgetMode','memoryMiB','pidsLimit','cpus','poolMemoryMiB','poolTasksMax'})
SESSION = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')


def validate_resources(value):
    if not isinstance(value,dict) or set(value)!=RESOURCE_FIELDS:
        raise ValueError('A session resource policy must specify exactly six resource fields')
    for key,low,high in [('memoryMiB',0,1048576),('pidsLimit',64,4096),('poolMemoryMiB',512,1048576),('poolTasksMax',128,32768)]:
        if type(value[key]) is not int or not low<=value[key]<=high:
            raise ValueError('Invalid session resource limit: '+key)
    if (type(value['cpus']) not in (int,float) or not(value['cpus']==0 or .25<=value['cpus']<=64) or
        value['memoryMiB']>value['poolMemoryMiB'] or value['budgetMode'] not in ('pool','admission') or
        (value['budgetMode']=='admission' and value['memoryMiB']<512)):
        raise ValueError('Invalid session resource budget')


def validate_session_resources(config):
    policies=config.get('sessionResources',{})
    if not isinstance(policies,dict) or len(policies)>32:
        raise ValueError('Invalid owner session resource map')
    for sid,policy in policies.items():
        if not isinstance(sid,str) or not SESSION.fullmatch(sid):
            raise ValueError('Invalid resource-policy session')
        validate_resources(policy)


def effective_config(config,sid):
    validate_session_resources(config)
    result={k:v for k,v in config.items() if k!='sessionResources'}
    result.update(config.get('sessionResources',{}).get(sid,{}))
    return result


def policy_digest(config,sid):
    effective=effective_config(config,sid)
    return hashlib.sha256(json.dumps({k:v for k,v in effective.items() if k not in ('image','maintenanceSessions','opsConfig')},sort_keys=True).encode()).hexdigest()


def validate_resource_reload(before,after):
    validate_session_resources(after)
    ignored=RESOURCE_FIELDS|{'sessionResources'}
    if {k:v for k,v in before.items() if k not in ignored}!={k:v for k,v in after.items() if k not in ignored}:
        raise ValueError('Resource reload cannot change laptop grants, images or control paths')
