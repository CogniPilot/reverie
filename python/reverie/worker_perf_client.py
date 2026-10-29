"""Fixed host-owner task perf policy client; no stop/start or arbitrary commands."""
import argparse
import copy
import json
from pathlib import Path
import os
import struct
import sys
import time

if __package__ in (None,''):
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]));__package__='reverie'

from .worker import load_config,send_frame
from .worker_service import WorkerService
from .resource_actor_refresh import RegisteredTransport
from .worker_resume_peer import host_peer
from .worker_perf_access import decode
from . import laptop_resource_operations as J
from .worker_perf import POLICY


class PerfTransport(RegisteredTransport):
    """Only the exact approved selected-EID perf config may change in this call."""
    def finalize_apply(self,expected):
        after=load_config(self.service.config_path)
        if after!=expected:raise ValueError('Applied perf configuration differs')
        before=self.selection
        self.config=after
        observed=self.observe()
        if {k:v for k,v in observed.items() if k!='config'}!={k:v for k,v in before.items() if k!='config'}:
            raise ValueError('Registered broker changed across perf configuration CAS')
        self.selection=observed
        self.finalize()


def _call(config_path,command,plan=None):
    proof=None
    try:
        config=load_config(config_path);proof=PerfTransport(WorkerService(config_path),config)
        host_peer(proof.credentials,config['uid']);proof.guard()
        expected=None
        if command['action']=='perf-policy-apply':
            if (type(plan)is not dict or J.fingerprint(plan)!=command['planDigest']
                    or plan.get('purpose')!='owner-task-perf-cold-plan-v1'
                    or plan.get('employeeId')!=command['employeeId']
                    or plan.get('beforeDigest')!=J.fingerprint(config)):
                raise ValueError('Exact approved cold perf preview required')
            desired=plan['request']['policy']
            if desired is not None and desired!=POLICY:raise ValueError('Fixed perf policy required')
            expected=copy.deepcopy(config);policies=expected.setdefault('employeePerfPolicies',{})
            if desired is None:policies.pop(command['employeeId'],None)
            else:policies[command['employeeId']]=POLICY
            if J.fingerprint(expected)!=plan.get('afterDigest'):
                raise ValueError('Preview includes an unrelated config change')
        deadline=time.monotonic()+40
        def take(count):
            raw=bytearray()
            while len(raw)<count:
                remaining=deadline-time.monotonic()
                if remaining<=0:raise TimeoutError('Task perf response deadline')
                proof.socket.settimeout(remaining);part=proof.socket.recv(count-len(raw))
                if not part:raise EOFError
                raw.extend(part)
            return bytes(raw)
        send_frame(proof.socket,b'C',json.dumps(command,separators=(',',':'),allow_nan=False).encode())
        header=take(5);length=struct.unpack('!I',header[1:])[0]
        if header[:1]!=b'J' or not 0<length<=65536:raise ValueError('Task perf operation unconfirmed')
        result=decode(take(length))
        if type(result)is not dict or result.get('version')!=1 or result.get('purpose')!='owner-task-perf-v1':
            raise ValueError('Task perf reply unavailable')
        if expected is not None:
            if result.get('state')!='CONFIGURED_COLD_RECREATE_REQUIRED' or result.get('planDigest')!=command['planDigest']:
                raise ValueError('Perf configuration outcome unconfirmed')
            proof.finalize_apply(expected)
        else:proof.finalize()
        proof=None
        return result
    finally:
        if proof is not None:proof.close()


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__,allow_abbrev=False)
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('--employee',required=True)
    parser.add_argument('action',choices=('status','request','preview','apply'))
    choice=parser.add_mutually_exclusive_group();choice.add_argument('--enable',action='store_true');choice.add_argument('--disable',action='store_true')
    parser.add_argument('--plan-digest')
    args=parser.parse_args(argv);os.umask(0o077)
    if (args.action=='request') != (args.enable or args.disable) or (args.action=='apply') != (args.plan_digest is not None):
        parser.error('Request requires --enable/--disable; apply requires only --plan-digest')
    command={'action':'perf-policy-'+args.action,'employeeId':args.employee}
    try:
        if args.action=='request':
            status=_call(args.config,{'action':'perf-policy-status','employeeId':args.employee})
            current=status['current']
            command.update(enabled=args.enable,expected={k:current[k] for k in ('sessionId','sessionGeneration','bindingDigest')})
            command['expected']['revision']=status['revision']
        plan=None
        if args.action=='apply':
            command['planDigest']=args.plan_digest
            preview=_call(args.config,{'action':'perf-policy-preview','employeeId':args.employee})
            if preview.get('state')!='READY_COLD' or preview.get('planDigest')!=args.plan_digest:
                raise ValueError('Fresh cold preview differs; review again')
            plan=preview['plan']
        result=_call(args.config,command,plan)
        print(json.dumps(result,separators=(',',':'),allow_nan=False));return 0
    except (OSError,ValueError,RuntimeError,EOFError,KeyError):
        print('Task perf operation unconfirmed. Inspect retained request/pending/attempt state; do not resend apply.',file=sys.stderr)
        return 1


if __name__=='__main__':raise SystemExit(main())
