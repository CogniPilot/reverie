"""Fixed host targets for the owner approval queue; not a public RPC server."""
import hashlib
import json
from pathlib import Path
import re

from .host_actions import validate_operation

UNIT_NAME = 'reverie-workers.slice'
MIB = 1048576


def _swap_pool(swap_pool_mib):
    if type(swap_pool_mib) is not int or not 0 <= swap_pool_mib <= 1048576:
        raise ValueError('Invalid laptop swap pool')
    return swap_pool_mib


def pool_unit(swap_pool_mib=0):
    """The fixed pool unit; only the owner-configured laptop swap pool varies."""
    swap = _swap_pool(swap_pool_mib)
    return (b'''[Unit]
Description=Reverie temporary worker pool
[Slice]
MemoryAccounting=yes
MemoryHigh=44236M
MemoryMax=49152M
MemorySwapMax=''' + (b'0' if swap == 0 else str(swap).encode() + b'M') + b'''
TasksMax=8192
CPUWeight=100
''')


def pool_limits(swap_pool_mib=0):
    return {'memory.max':'51539607552','pids.max':'8192',
            'memory.swap.max':str(_swap_pool(swap_pool_mib) * MIB)}


UNIT = pool_unit()
POOL = pool_limits()


class FixedTargets:
    """Injected engine/pool adapters are host-owned fixed interfaces.

    engine receives argv (never shell). pool exposes preview/apply/verify, with
    no client-selected unit/path/limits. A root helper must authenticate this
    service, independently of the office API. No root helper transport exists yet.
    """
    def __init__(self, deployment, engine, pool, swap_pool_mib=0):
        if not isinstance(deployment,str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}',deployment):
            raise ValueError('Invalid deployment identity')
        self.deployment = deployment
        self.engine = engine
        self.pool = pool
        self.unit = pool_unit(swap_pool_mib)

    def laptop(self, session):
        name = self.deployment+'-agent-'+session
        records = json.loads(self.engine(['inspect',name]))
        if len(records) != 1:
            raise ValueError('Expected one laptop')
        item = records[0]
        labels = item['Config']['Labels'] or {}
        if (labels.get('reverie.worker') != self.deployment or
            labels.get('reverie.session') != session or item['Name'] != '/'+name or
            not re.fullmatch('[0-9a-f]{64}',item['Id'])):
            raise ValueError('Laptop ownership mismatch')
        return item

    def resolve(self, operation):
        operation=validate_operation(operation)
        if operation['action']=='stop-laptop':
            item=self.laptop(operation['sessionId'])
            if item['State']['Running'] is not True:
                raise ValueError('Laptop is not running')
            return {'containerId':item['Id'],'sessionId':operation['sessionId'],
                    'deployment':self.deployment,'policyDigest':item['Config']['Labels'].get('reverie.worker-policy')}
        preview=self.pool.preview()
        return {'unit':UNIT_NAME,'desiredUnitSha256':hashlib.sha256(self.unit).hexdigest(),
                'existingUnitSha256':preview['existingUnitSha256']}

    def execute(self, operation, preview, permit):
        operation=validate_operation(operation)
        if self.resolve(operation) != preview:
            raise ValueError('Approved target changed')
        permit.check()
        if operation['action']=='stop-laptop':
            # Only this exact immutable ID; never all, a shell, or caller argv.
            permit.begin()
            self.engine(['stop','--time','20',preview['containerId']])
            item=self.laptop(operation['sessionId'])
            if item['Id'] != preview['containerId'] or item['State']['Running'] is not False:
                raise RuntimeError('Laptop stop outcome requires verification')
        else:
            if operation['action']=='apply-runtime-pool':
                self.pool.apply(permit)
            self.pool.verify()


class RuntimePoolProof:
    """Read-only proof; production root is fixed, injection is for fixtures only."""
    def __init__(self, root=Path('/sys/fs/cgroup/reverie.slice/reverie-workers.slice'), swap_pool_mib=0):
        self.root=Path(root)
        self.limits=pool_limits(swap_pool_mib)

    def verify(self):
        for name,value in self.limits.items():
            if (self.root/name).read_text().strip()!=value:
                raise ValueError('Runtime pool limit differs: '+name)
        if (self.root/'cpu.max').read_text().split()[0]!='max':
            raise ValueError('Runtime pool CPU is capped')
